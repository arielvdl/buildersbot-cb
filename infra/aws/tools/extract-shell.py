#!/usr/bin/env python3
"""Writes the shell embedded in the templates (EC2 user data and SSM Command documents) to files, so
that shellcheck can read it. Fn::Sub names become SUBVALUE and SSM parameters become PARAM_<name>.

Usage: extract-shell.py <output-dir> <template.yaml>...
"""

import re
import sys
from pathlib import Path

import yaml


class Loader(yaml.SafeLoader):
    pass


def construct(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    return {("Ref" if suffix == "Ref" else "Fn::" + suffix): value}


Loader.add_multi_constructor("!", construct)


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for path in map(Path, sys.argv[2:]):
        template = yaml.load(path.read_text(), Loader=Loader)
        for name, resource in (template.get("Resources") or {}).items():
            props = resource.get("Properties") or {}
            user_data = props.get("UserData")
            if isinstance(user_data, dict):
                sub = user_data.get("Fn::Base64", {}).get("Fn::Sub")
                text = sub[0] if isinstance(sub, list) else sub
                if isinstance(text, str):
                    text = re.sub(r"\$\{([A-Za-z0-9:]+)\}", "SUBVALUE", text)
                    text = re.sub(r"\$\{!([^}]*)\}", r"${\1}", text)
                    (out / f"{path.stem}.{name}.userdata.sh").write_text(text)
            if resource.get("Type") == "AWS::SSM::Document" and props.get("DocumentType") == "Command":
                for step in props["Content"]["mainSteps"]:
                    for index, command in enumerate(step["inputs"]["runCommand"]):
                        text = re.sub(r"\{\{\s*(\w+)\s*\}\}", r"PARAM_\1", command)
                        (out / f"{path.stem}.{name}.{index}.sh").write_text(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
