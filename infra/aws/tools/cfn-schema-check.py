#!/usr/bin/env python3
"""Offline checks of CloudFormation templates against the official resource schemas.

cfn-lint is not installed on the operator computer, so this script does the checks that matter most
here, with the schemas that `aws cloudformation describe-type` returns (read-only):

- each resource property exists in the schema of its type, and required properties are present;
- read-only properties are not set;
- Ref, Fn::GetAtt, Condition and DependsOn name things that exist;
- every ${Name} of Fn::Sub is a parameter, a resource (or Resource.Attribute), a pseudo parameter or a
  key of the variable map (this catches a shell variable written with braces in user data);
- JSON values of AWS::SSM::Parameter parse after substitution;
- the template body is at most 51,200 bytes (the limit of --template-body).

Usage: cfn-schema-check.py <schema-dir> <template.yaml>...
The schema directory has one file per type, named like AWS__EC2__Instance.json.
"""

import json
import re
import sys
from pathlib import Path

import yaml

PSEUDO = {
    "AWS::AccountId", "AWS::NotificationARNs", "AWS::NoValue", "AWS::Partition", "AWS::Region",
    "AWS::StackId", "AWS::StackName", "AWS::URLSuffix",
}
BODY_LIMIT = 51200


class Tagged:
    def __init__(self, tag, value):
        self.tag = tag
        self.value = value


def construct(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    name = suffix
    if name == "Ref":
        return {"Ref": value}
    if name == "GetAtt" and isinstance(value, str):
        value = value.split(".", 1)
    if name == "Condition":
        return {"Condition": value}
    return {"Fn::" + name: value}


class Loader(yaml.SafeLoader):
    pass


Loader.add_multi_constructor("!", construct)


def load_schema(directory, type_name, cache):
    if type_name in cache:
        return cache[type_name]
    path = Path(directory) / (type_name.replace("::", "__") + ".json")
    if not path.exists():
        cache[type_name] = None
        return None
    cache[type_name] = json.loads(path.read_text())
    return cache[type_name]


def resolve(schema, node):
    seen = 0
    while isinstance(node, dict) and "$ref" in node and seen < 20:
        ref = node["$ref"]
        if not ref.startswith("#/definitions/"):
            return {}
        node = schema.get("definitions", {}).get(ref.split("/")[-1], {})
        seen += 1
    return node if isinstance(node, dict) else {}


def object_shapes(schema, node):
    """All object shapes a schema node allows (oneOf/anyOf give several)."""
    node = resolve(schema, node)
    shapes = []
    for key in ("oneOf", "anyOf", "allOf"):
        for sub in node.get(key, []):
            shapes.extend(object_shapes(schema, sub))
    if "properties" in node or node.get("type") == "object" or "patternProperties" in node:
        shapes.append(node)
    return shapes


def is_intrinsic(value):
    return isinstance(value, dict) and len(value) == 1 and next(iter(value)) in (
        "Ref", "Condition") or (isinstance(value, dict) and len(value) == 1 and next(iter(value)).startswith("Fn::"))


def check_value(schema, node, value, path, errors):
    if is_intrinsic(value):
        key = next(iter(value))
        if key == "Fn::If" and isinstance(value[key], list) and len(value[key]) == 3:
            for branch in value[key][1:]:
                if branch != {"Ref": "AWS::NoValue"}:
                    check_value(schema, node, branch, path, errors)
        return
    node = resolve(schema, node)
    if isinstance(value, list):
        items = node.get("items")
        if items is None:
            for key in ("oneOf", "anyOf"):
                for sub in node.get(key, []):
                    sub = resolve(schema, sub)
                    if sub.get("type") == "array" or "items" in sub:
                        items = sub.get("items")
        if items is not None:
            for index, item in enumerate(value):
                check_value(schema, items, item, f"{path}[{index}]", errors)
        return
    if isinstance(value, dict):
        shapes = object_shapes(schema, node)
        if not shapes:
            return
        open_shape = any(
            not s.get("properties") or s.get("patternProperties") or s.get("additionalProperties") not in (False, None)
            and not s.get("properties") for s in shapes)
        known = {}
        required = None
        for shape in shapes:
            known.update(shape.get("properties", {}))
            if shape.get("required") and required is None:
                required = shape["required"]
        if open_shape and not known:
            return
        for key, sub in value.items():
            if key not in known:
                if not open_shape:
                    errors.append(f"{path}: unknown property {key!r} (known: {', '.join(sorted(known))})")
                continue
            check_value(schema, known[key], sub, f"{path}.{key}", errors)
        if required and len(shapes) == 1:
            for key in required:
                if key not in value:
                    errors.append(f"{path}: missing required property {key!r}")


def walk(value, visit):
    visit(value)
    if isinstance(value, dict):
        for sub in value.values():
            walk(sub, visit)
    elif isinstance(value, list):
        for sub in value:
            walk(sub, visit)


SUB_NAME = re.compile(r"\$\{([^}!][^}]*)\}")


def check_template(schema_dir, path, cache):
    errors = []
    body = Path(path).read_bytes()
    if len(body) > BODY_LIMIT:
        errors.append(f"template body is {len(body)} bytes, more than {BODY_LIMIT} (--template-body limit)")
    template = yaml.load(body, Loader=Loader)
    params = set((template.get("Parameters") or {}).keys())
    resources = template.get("Resources") or {}
    conditions = set((template.get("Conditions") or {}).keys())
    mappings = template.get("Mappings") or {}
    names = params | set(resources) | PSEUDO

    def visit(node):
        if not isinstance(node, dict) or len(node) != 1:
            return
        key, value = next(iter(node.items()))
        if key == "Ref" and isinstance(value, str) and value not in names:
            errors.append(f"Ref to unknown {value!r}")
        elif key == "Fn::GetAtt":
            target = value[0] if isinstance(value, list) else str(value).split(".")[0]
            if target not in resources:
                errors.append(f"GetAtt on unknown resource {target!r}")
        elif key == "Condition" and isinstance(value, str) and value not in conditions:
            errors.append(f"unknown condition {value!r}")
        elif key == "Fn::If" and isinstance(value, list) and value and value[0] not in conditions:
            errors.append(f"Fn::If with unknown condition {value[0]!r}")
        elif key == "Fn::FindInMap" and isinstance(value, list) and isinstance(value[0], str) and value[0] not in mappings:
            errors.append(f"FindInMap on unknown mapping {value[0]!r}")
        elif key == "Fn::Sub":
            text, variables = (value, {}) if isinstance(value, str) else (value[0], value[1] if len(value) > 1 else {})
            if not isinstance(text, str):
                return
            for name in SUB_NAME.findall(text):
                base = name.split(".")[0]
                if name in variables or name in names or (base in resources and "." in name):
                    continue
                errors.append(f"Fn::Sub names unknown ${{{name}}} (write shell variables without braces or as ${{!{name}}})")

    walk(template, visit)

    for logical, resource in resources.items():
        rtype = resource.get("Type", "")
        for key in ("Condition",):
            if key in resource and resource[key] not in conditions:
                errors.append(f"{logical}: unknown condition {resource[key]!r}")
        depends = resource.get("DependsOn", [])
        for dep in [depends] if isinstance(depends, str) else depends:
            if dep not in resources:
                errors.append(f"{logical}: DependsOn unknown {dep!r}")
        schema = load_schema(schema_dir, rtype, cache)
        if schema is None:
            errors.append(f"{logical}: no schema for {rtype} in {schema_dir}")
            continue
        props = resource.get("Properties", {}) or {}
        read_only = {p.split("/")[-1] for p in schema.get("readOnlyProperties", []) if p.count("/") == 2}
        for key in props:
            if key in read_only:
                errors.append(f"{logical}: read-only property {key!r} is set")
        check_value(schema, {"type": "object", "properties": schema.get("properties", {}),
                             "required": schema.get("required", []), "additionalProperties": False},
                    props, f"{logical}({rtype})", errors)
        if rtype == "AWS::SSM::Parameter":
            value = props.get("Value")
            text = value if isinstance(value, str) else (value.get("Fn::Sub") if isinstance(value, dict) else None)
            if isinstance(text, str) and text.lstrip().startswith("{"):
                try:
                    json.loads(SUB_NAME.sub("x", text))
                except ValueError as error:
                    errors.append(f"{logical}: Value is not valid JSON: {error}")
    return errors


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cache = {}
    failed = 0
    for path in sys.argv[2:]:
        errors = check_template(sys.argv[1], path, cache)
        if errors:
            failed += 1
            print(f"FAIL {path}")
            for error in errors:
                print(f"  - {error}")
        else:
            print(f"ok   {path}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
