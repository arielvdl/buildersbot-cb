#!/usr/bin/env bash
# Testes negativos, sem AWS: cada caminho de recusa novo roda contra um `aws` falso (tests/fake-bin),
# que responde às leituras do cenário e recusa qualquer escrita. Um caso passa quando o script para
# com a mensagem esperada E não tentou nenhuma escrita. Os casos "aceita" são o controle: mostram que
# o mesmo cenário, sem o defeito, passa da checagem.
#
# Uso: tests/negative.sh   (scripts/validate.sh também roda)
# Os bash -c entre aspas simples expandem $0/$1 no bash filho, de propósito.
# shellcheck disable=SC2016
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$ROOT/.cache/tests
install -d "$WORK"
export FAKE_AWS_LOG=$WORK/fake-aws.log
export PATH="$ROOT/tests/fake-bin:$PATH"
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
unset BB_SRV_YES BB_SRV_ALLOW_LONG_TERM_KEY BB_SRV_IGNORE_QUOTA BB_SRV_ACCEPT_CRITICAL
cd "$ROOT" || exit 1

passed=0
failed=0
bad() {
  failed=$((failed + 1))
  printf 'FALHOU %s\n' "$1"
  [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/       | /' | tail -n 15
}

# <nome> <texto esperado na saída> <handler do aws falso> <comando...>
expect_refusal() {
  local name=$1 expect=$2 handler=$3 out status
  shift 3
  : >"$FAKE_AWS_LOG"
  out=$(FAKE_AWS_HANDLER=$handler "$@" 2>&1 </dev/null)
  status=$?
  if [ "$status" = 0 ]; then
    bad "$name: esperava recusa, saiu com 0" "$out"
  elif ! grep -qF -- "$expect" <<<"$out"; then
    bad "$name: a saída não tem '$expect'" "$out"
  elif grep -q '^WRITE' "$FAKE_AWS_LOG"; then
    bad "$name: tentou escrever na AWS ($(grep '^WRITE' "$FAKE_AWS_LOG" | head -n 1))" "$out"
  else
    passed=$((passed + 1))
    printf 'ok     %s\n' "$name"
  fi
}

# <nome> <texto esperado> <handler> <comando...>: controle, tem de sair com 0 e sem escrita.
expect_success() {
  local name=$1 expect=$2 handler=$3 out status
  shift 3
  : >"$FAKE_AWS_LOG"
  out=$(FAKE_AWS_HANDLER=$handler "$@" 2>&1 </dev/null)
  status=$?
  if [ "$status" != 0 ]; then
    bad "$name: esperava sucesso, saiu com $status" "$out"
  elif ! grep -qF -- "$expect" <<<"$out"; then
    bad "$name: a saída não tem '$expect'" "$out"
  elif grep -q '^WRITE' "$FAKE_AWS_LOG"; then
    bad "$name: tentou escrever na AWS" "$out"
  else
    passed=$((passed + 1))
    printf 'ok     %s\n' "$name"
  fi
}

# Roda uma função de scripts/lib.sh num bash novo.
lib() { bash -c 'source "$0/scripts/lib.sh"; "$@"' "$ROOT" "$@"; }

hex64() { # <caractere>: 64 vezes
  local _ out=''
  for _ in $(seq 1 64); do out=$out$1; done
  printf '%s' "$out"
}
DIGEST_A=sha256:$(hex64 a)
DIGEST_B=sha256:$(hex64 b)
DIGEST_C=sha256:$(hex64 c)
TAG=0.41.0-abc1234-arm64
export TAG DIGEST_A DIGEST_B DIGEST_C

# ---------------------------------------------------------------- A: confiança na imagem (achado 1)
# Relatório do builder: imagem A e bundle C. O ECR responde pela tag.
report() { # <tag no relatório> <opsTag>
  printf '{"tag":"%s","opsTag":"%s","imageDigest":"%s","opsDigest":"%s","version":"0.41.0","arch":"arm64","smokeTest":"passed","rejected":false}\n' \
    "$1" "$2" "$DIGEST_A" "$DIGEST_C"
}
image_by_tag() { # <args do aws>: devolve o digest da tag pedida conforme FAKE_ECR_IMAGE / FAKE_ECR_OPS
  local arg
  for arg in "$@"; do
    case $arg in
      imageTag=*-ops) echo "${FAKE_ECR_OPS:-$DIGEST_C}"; return 0 ;;
      imageTag=*) echo "${FAKE_ECR_IMAGE:-$DIGEST_A}"; return 0 ;;
    esac
  done
  return 1
}
h_image() {
  case "$1 $2" in
    "cloudformation describe-stacks") echo bb-srv-build-358748433479 ;;
    "s3 cp") report "${FAKE_REPORT_TAG:-$TAG}" "${FAKE_REPORT_OPS:-0.41.0-abc1234-ops}" ;;
    "ecr describe-images") image_by_tag "$@" ;;
    "ecr describe-image-scan-findings") echo None ;;
    *) return 1 ;;
  esac
}
export -f report image_by_tag h_image

expect_success "A1 aceita relatório que bate com o ECR" "imagem $TAG" h_image lib resolve_image "$TAG" arm64
expect_refusal "A1 recusa tag que aponta no ECR para outro digest" "não bate com o ECR" h_image \
  env FAKE_ECR_IMAGE="$DIGEST_B" bash -c 'source "$0/scripts/lib.sh"; resolve_image "$1" arm64' "$ROOT" "$TAG"
expect_refusal "A1 recusa bundle -ops que aponta no ECR para outro digest" "não bate com o ECR" h_image \
  env FAKE_ECR_OPS="$DIGEST_B" bash -c 'source "$0/scripts/lib.sh"; resolve_image "$1" arm64' "$ROOT" "$TAG"
expect_refusal "A1 recusa relatório com outra tag dentro" "diz outra tag" h_image \
  env FAKE_REPORT_TAG=0.40.0-0000000-arm64 bash -c 'source "$0/scripts/lib.sh"; resolve_image "$1" arm64' "$ROOT" "$TAG"
expect_refusal "A1 recusa opsTag de outro build" "não é 0.41.0-abc1234-ops" h_image \
  env FAKE_REPORT_OPS=0.40.0-0000000-ops bash -c 'source "$0/scripts/lib.sh"; resolve_image "$1" arm64' "$ROOT" "$TAG"

# ---------------------------------------------------------------- A: código conferido no builder (achado 9)
expect_refusal "A9 on-host recusa rodar sem o sha256 do tarball" "parâmetros inválidos" "" \
  bash scripts/build-image.sh on-host --commit "$(hex64 1 | cut -c 1-40)" --bucket b --repo-uri r --version 1.2.3

# ---------------------------------------------------------------- respostas genéricas de stacks
# FAKE_STACKS="stack=STATUS ...", FAKE_PARAM_<Key>, FAKE_OUTPUT_<Key>. Stack fora da lista = não existe.
fake_cfn() {
  local stack='' query='' prev='' a pair key var
  for a in "$@"; do
    case $prev in --stack-name) stack=$a ;; --query) query=$a ;; esac
    prev=$a
  done
  for pair in ${FAKE_STACKS:-}; do
    [ "${pair%%=*}" = "$stack" ] || continue
    case $query in
      *StackStatus*) echo "${pair#*=}"; return 0 ;;
      *ParameterKey==*)
        key=$(sed -n "s/.*ParameterKey=='\([A-Za-z0-9]*\)'.*/\1/p" <<<"$query"); var=FAKE_PARAM_$key
        echo "${!var:-None}"; return 0 ;;
      *OutputKey==*)
        key=$(sed -n "s/.*OutputKey=='\([A-Za-z0-9]*\)'.*/\1/p" <<<"$query"); var=FAKE_OUTPUT_$key
        echo "${!var:-None}"; return 0 ;;
      *Parameters\[\].ParameterKey*) echo "${FAKE_PARAM_KEYS:-}"; return 0 ;;
    esac
  done
  return 1
}
export -f fake_cfn

# <nome> <regex que o log TEM de ter> <regex que o log NÃO pode ter> <handler> <comando...>
# Para os casos em que o script deve chegar até a primeira escrita (que o aws falso recusa).
expect_calls() {
  local name=$1 must=$2 mustnt=$3 handler=$4 out
  shift 4
  : >"$FAKE_AWS_LOG"
  out=$(FAKE_AWS_HANDLER=$handler "$@" 2>&1 </dev/null)
  if ! grep -Eq -- "$must" "$FAKE_AWS_LOG"; then
    bad "$name: o log não tem /$must/" "$out"$'\n'"$(cat "$FAKE_AWS_LOG")"
  elif grep -Eq -- "$mustnt" "$FAKE_AWS_LOG"; then
    bad "$name: o log tem /$mustnt/" "$(cat "$FAKE_AWS_LOG")"
  else
    passed=$((passed + 1))
    printf 'ok     %s\n' "$name"
  fi
}

# Um "fork" de teste com dois commits (fica em .cache, ignorado pelo git do repositório).
FORK=$WORK/fork
if [ ! -d "$FORK/.git" ]; then
  git init -q "$FORK"
  printf '{"workspaces": {"catalog": {"wrangler": "4.152.0"}}}\n' >"$FORK/package.json"
  git -C "$FORK" add package.json
  git -C "$FORK" -c user.name=teste -c user.email=teste@example.com commit -q -m um
  git -C "$FORK" -c user.name=teste -c user.email=teste@example.com commit -q --allow-empty -m dois
fi
FIRST=$(git -C "$FORK" rev-parse HEAD~1)
SECOND=$(git -C "$FORK" rev-parse HEAD)
export BB_SRV_FORK=$FORK

# ---------------------------------------------------------------- B: Signal (achado 13)
h_signal() {
  case "$1 $2" in
    "cloudformation describe-stacks") fake_cfn "$@" ;;
    "ssm describe-parameters") echo 1 ;;
    *) return 1 ;;
  esac
}
export -f h_signal
signal_env() {
  env FAKE_STACKS="bb-srv-base=CREATE_COMPLETE bb-srv-signal=UPDATE_COMPLETE" FAKE_OUTPUT_HostedZoneName=bb-aws.example.com \
    FAKE_OUTPUT_HostedZoneId=Z123 FAKE_PARAM_SourceCommit="$FIRST" FAKE_PARAM_AcmeEmail=acme@example.com "$@"
}
expect_refusal "B13 atualização recusa outro commit (exige recriar a VM)" "Trocar o commit exige recriar" h_signal \
  signal_env bash scripts/deploy-signal.sh --commit "$SECOND"
expect_refusal "B13 atualização recusa outro e-mail ACME" "Trocar exige recriar" h_signal \
  signal_env bash scripts/deploy-signal.sh --acme-email outro@example.com
expect_calls "B13 fechar as portas não resolve AMI nem cota, e mantém a AMI" \
  'WRITE cloudformation create-change-set .*ParameterKey=AmiId,UsePreviousValue=true.*IngressApproved,ParameterValue=false' \
  'ssm get-parameters|service-quotas|s3api head-object|route53' h_signal signal_env bash scripts/deploy-signal.sh

# ---------------------------------------------------------------- C: stacks em falha (achado 14)
h_failed() {
  case "$1 $2" in
    "cloudformation describe-stacks") fake_cfn "$@" ;;
    "cloudformation describe-stack-events") echo "Instance DELETE_FAILED OperationNotPermitted" ;;
    "cloudformation describe-stack-resources") echo i-0123456789abcdef0 ;;
    *) return 1 ;;
  esac
}
export -f h_failed
expect_refusal "C14 ROLLBACK_FAILED mostra como tirar a proteção e apagar" \
  "modify-instance-attribute --instance-id i-0123456789abcdef0 --no-disable-api-termination" h_failed \
  env FAKE_STACKS="bb-srv-piloto-compute=ROLLBACK_FAILED" bash -c 'source "$0/scripts/lib.sh"; deploy_stack bb-srv-piloto-compute "$0/templates/sector-compute.yaml" piloto' "$ROOT"
expect_refusal "C14 UPDATE_ROLLBACK_FAILED mostra o continue-update-rollback" "continue-update-rollback --stack-name bb-srv-piloto-compute" h_failed \
  env FAKE_STACKS="bb-srv-piloto-compute=UPDATE_ROLLBACK_FAILED" bash -c 'source "$0/scripts/lib.sh"; deploy_stack bb-srv-piloto-compute "$0/templates/sector-compute.yaml" piloto' "$ROOT"
expect_refusal "C14 @previous recusa stack que não existe" "não há template anterior" h_failed \
  bash -c 'source "$0/scripts/lib.sh"; deploy_stack bb-srv-piloto-compute @previous piloto' "$ROOT"

expect_calls "C14 proteção liga só TerminationProtection e ImageTag, sobre o template já implantado" \
  'WRITE cloudformation create-change-set .*--use-previous-template.*Sector,UsePreviousValue=true.*AmiId,UsePreviousValue=true.*TerminationProtection,ParameterValue=true ParameterKey=ImageTag,ParameterValue=0.41.0-abc1234-arm64' \
  'template-body|AmiId,ParameterValue' h_failed \
  env FAKE_STACKS="bb-srv-piloto-compute=CREATE_COMPLETE" FAKE_PARAM_KEYS="Sector Size AmiId TerminationProtection ImageTag" \
  bash -c 'source "$0/scripts/lib.sh"; protect_sector piloto "$1"' "$ROOT" "$TAG"

# ---------------------------------------------------------------- C: retomar o add-sector (achado 15)
h_sector() {
  case "$1 $2" in
    "cloudformation describe-stacks") fake_cfn "$@" ;;
    "ssm get-parameter") [ -n "${FAKE_IMAGE:-}" ] && echo "$FAKE_IMAGE" ;;
    *) return 1 ;;
  esac
}
export -f h_sector
sector_env() {
  env FAKE_STACKS="bb-srv-base=CREATE_COMPLETE bb-srv-ops=CREATE_COMPLETE bb-srv-signal=CREATE_COMPLETE ${EXTRA_STACKS:-}" \
    FAKE_PARAM_Size=large FAKE_OUTPUT_InstanceId=i-0123456789abcdef0 "$@"
}
export EXTRA_STACKS="bb-srv-piloto-compute=CREATE_COMPLETE bb-srv-piloto-data=CREATE_COMPLETE"
expect_refusal "C15 setor existente sem --resume indica o --resume" "scripts/add-sector.sh piloto --resume" h_sector \
  sector_env bash scripts/add-sector.sh piloto
expect_refusal "C15 --resume num setor instalado e protegido não faz nada" "nada a retomar" h_sector \
  sector_env FAKE_IMAGE="x@$DIGEST_A" FAKE_PARAM_TerminationProtection=true bash scripts/add-sector.sh piloto --resume
expect_refusal "C15 --resume não troca o tamanho" "não troca o tamanho" h_sector \
  sector_env bash scripts/add-sector.sh piloto medium --resume
expect_refusal "C15 --resume não combina com --from-snapshot" "não combina" h_sector \
  sector_env bash scripts/add-sector.sh piloto --resume --from-snapshot snap-0123456789abcdef0
EXTRA_STACKS='' expect_refusal "C15 --resume sem a stack -compute pede o fluxo normal" "rode sem --resume" h_sector \
  sector_env bash scripts/add-sector.sh piloto --resume

# ---------------------------------------------------------------- C: nome do servidor no login (achado 23)
expect_refusal "C23 login recusa nome com aspas" "nome do servidor inválido" h_sector \
  sector_env bash scripts/login-sector.sh piloto bb-piloto@example.com "CB x'y"
expect_refusal "C23 login recusa nome começando com hífen" "nome do servidor inválido" h_sector \
  sector_env bash scripts/login-sector.sh piloto bb-piloto@example.com "-CB piloto"
EXTRA_STACKS="bb-srv-rh-compute=CREATE_COMPLETE" expect_calls "C23 login aceita 'CB rh' (chega na sessão, que o aws falso recusa)" \
  'WRITE ssm start-session .*bb-srv-rh-Login' 'NADA' h_sector sector_env bash scripts/login-sector.sh rh bb-rh@example.com "CB rh"
EXTRA_STACKS="bb-srv-rh-juridico-compute=CREATE_COMPLETE" expect_calls "C23 login aceita 'CB rh-juridico'" \
  'WRITE ssm start-session .*bb-srv-rh-juridico-Login' 'NADA' h_sector \
  sector_env bash scripts/login-sector.sh rh-juridico bb-rh-juridico@example.com "CB rh-juridico"

printf '\n%s ok, %s falharam\n' "$passed" "$failed"
[ "$failed" = 0 ]
