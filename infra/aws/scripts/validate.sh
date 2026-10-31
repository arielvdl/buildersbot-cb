#!/usr/bin/env bash
# Validação sem criar nada na AWS:
#   1. aws cloudformation validate-template em cada template (leitura);
#   2. tools/cfn-schema-check.py contra os esquemas oficiais (describe-type, leitura; cache em .cache/);
#   3. cfn-lint, se estiver instalado;
#   4. shellcheck nos scripts e nos testes, se estiver instalado, e bash -n em todos;
#   5. tests/negative.sh: os caminhos de recusa contra um `aws` falso que recusa qualquer escrita.
#
# Uso: scripts/validate.sh
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

bb_check_access
failed=0
schemas=$BB_ROOT/.cache/schemas
install -d "$schemas"

say "== validate-template"
for template in "$BB_ROOT"/templates/*.yaml; do
  if aws_cb cloudformation validate-template --template-body "file://$template" >/dev/null; then
    say "   ok   ${template#"$BB_ROOT"/}"
  else
    say "   FAIL ${template#"$BB_ROOT"/}"
    failed=1
  fi
done

say "== esquemas dos recursos (describe-type)"
# Só tipos de recurso (AWS::X::Y no fim da linha), não tipos de parâmetro como AWS::EC2::AvailabilityZone::Name.
types=$(grep -hE '^[[:space:]]+Type: AWS::[A-Za-z0-9]+::[A-Za-z0-9]+[[:space:]]*$' "$BB_ROOT"/templates/*.yaml | awk '{print $2}' | sort -u)
for type in $types; do
  file="$schemas/$(printf '%s' "$type" | sed 's/::/__/g').json"
  [ -s "$file" ] || aws_cb cloudformation describe-type --type RESOURCE --type-name "$type" --query Schema --output text >"$file"
done
python=''
for candidate in python3 /opt/homebrew/bin/python3.14 /usr/bin/python3; do
  if command -v "$candidate" >/dev/null && "$candidate" -I -c 'import yaml' 2>/dev/null; then python=$candidate; break; fi
done
if [ -n "$python" ]; then
  "$python" -I "$BB_ROOT/tools/cfn-schema-check.py" "$schemas" "$BB_ROOT"/templates/*.yaml || failed=1
else
  warn "nenhum python3 com PyYAML: pulei a checagem de esquemas."
fi

if command -v cfn-lint >/dev/null; then
  say "== cfn-lint"
  cfn-lint "$BB_ROOT"/templates/*.yaml || failed=1
else
  say "== cfn-lint não instalado (pulado)"
fi

say "== bash -n (scripts e testes)"
for script in "$BB_ROOT"/scripts/*.sh "$BB_ROOT"/tests/*.sh "$BB_ROOT"/tests/fake-bin/*; do
  bash -n "$script" || { say "   FAIL ${script#"$BB_ROOT"/}"; failed=1; }
done

if command -v shellcheck >/dev/null; then
  say "== shellcheck (scripts e testes)"
  if shellcheck -x -P "$BB_ROOT" "$BB_ROOT"/scripts/*.sh "$BB_ROOT"/tests/*.sh "$BB_ROOT"/tests/fake-bin/*; then say "   ok"; else failed=1; fi
  if [ -n "$python" ]; then
    say "== shellcheck (user data e documentos SSM dos templates)"
    embedded=$BB_ROOT/.cache/embedded
    install -d "$embedded"
    "$python" -I "$BB_ROOT/tools/extract-shell.py" "$embedded" "$BB_ROOT"/templates/*.yaml
    # SC2016: texto entre aspas simples com $ é proposital (heredocs e sh -c no container).
    if shellcheck -s bash -e SC2016 "$embedded"/*.sh; then say "   ok"; else failed=1; fi
  fi
else
  say "== shellcheck não instalado (pulado)"
fi

say "== testes negativos (aws falso, nenhuma escrita)"
if "$BB_ROOT/tests/negative.sh" | sed 's/^/   /'; then :; else failed=1; fi

[ "$failed" = 0 ] || die "a validação falhou."
say "validação ok"
