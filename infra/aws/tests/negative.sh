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
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN \
  AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_ENDPOINT_URL
unset BB_SRV_YES BB_SRV_ALLOW_LONG_TERM_KEY BB_SRV_IGNORE_QUOTA BB_SRV_ACCEPT_CRITICAL BB_SRV_ACCEPT_UNSCANNED
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

# Um "fork" de teste com dois commits (fica em .cache, ignorado pelo git do repositório). O primeiro
# tem a versão 0.41.0, que as tags dos testes usam.
FORK=$WORK/fork2
if [ ! -d "$FORK/.git" ]; then
  git init -q "$FORK"
  printf '{"version": "0.41.0", "workspaces": {"catalog": {"wrangler": "4.152.0"}}}\n' >"$FORK/package.json"
  git -C "$FORK" add package.json
  git -C "$FORK" -c user.name=teste -c user.email=teste@example.com commit -q -m um
  git -C "$FORK" -c user.name=teste -c user.email=teste@example.com commit -q --allow-empty -m dois
fi
FIRST=$(git -C "$FORK" rev-parse HEAD~1)
SECOND=$(git -C "$FORK" rev-parse HEAD)
SHORT=${FIRST:0:7}
SOURCE_HASH=$(git -C "$FORK" archive --format=tar.gz "$FIRST" | shasum -a 256 | cut -d ' ' -f 1)
export BB_SRV_FORK=$FORK
TAG=0.41.0-$SHORT-arm64
export TAG DIGEST_A DIGEST_B DIGEST_C FIRST SHORT SOURCE_HASH

# ---------------------------------------------------------------- A: confiança na imagem (achados 0 e 1)
# Relatório do builder: imagem A e bundle C, do commit FIRST. O ECR responde pela tag; a aprovação
# (/bb-srv/images/<tag>) é "A C"; o scan terminou sem CRITICAL.
report() { # <tag no relatório> <opsTag>
  printf '{"tag":"%s","opsTag":"%s","imageDigest":"%s","opsDigest":"%s","version":"%s","commit":"%s","sourceSha256":"%s","arch":"arm64","smokeTest":"passed","rejected":false,"builtAt":"2026-10-31T10:00:00Z"}\n' \
    "$1" "$2" "$DIGEST_A" "$DIGEST_C" "${FAKE_REPORT_VERSION:-0.41.0}" "${FAKE_REPORT_COMMIT:-$FIRST}" "${FAKE_REPORT_SOURCE:-$SOURCE_HASH}"
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
    "s3 cp") report "${FAKE_REPORT_TAG:-$TAG}" "${FAKE_REPORT_OPS:-0.41.0-$SHORT-ops}" ;;
    "s3api list-objects-v2") echo "reports/$TAG.json" ;;
    "ecr describe-images") image_by_tag "$@" ;;
    "ecr describe-image-scan-findings") [ "${FAKE_SCAN:-}" = fail ] && return 1; printf '%b\n' "${FAKE_SCAN:-COMPLETE\tNone}" ;;
    "ssm get-parameter") [ "${FAKE_NO_ANCHOR:-0}" = 1 ] && return 1; echo "${FAKE_ANCHOR:-$DIGEST_A $DIGEST_C}" ;;
    *) return 1 ;;
  esac
}
export -f report image_by_tag h_image
resolve() { bash -c 'source "$0/scripts/lib.sh"; resolve_image "$1" arm64' "$ROOT" "$@"; }
export -f resolve
export ROOT

expect_success "A1 aceita relatório que bate com o ECR e com a aprovação" "imagem $TAG" h_image lib resolve_image "$TAG" arm64
expect_refusal "A1 recusa tag que aponta no ECR para outro digest" "não bate com o ECR" h_image \
  env FAKE_ECR_IMAGE="$DIGEST_B" bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 recusa bundle -ops que aponta no ECR para outro digest" "não bate com o ECR" h_image \
  env FAKE_ECR_OPS="$DIGEST_B" bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 recusa relatório com outra tag dentro" "diz outra tag" h_image \
  env FAKE_REPORT_TAG=0.40.0-0000000-arm64 bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 recusa opsTag de outro build" "não é 0.41.0-$SHORT-ops" h_image \
  env FAKE_REPORT_OPS=0.40.0-0000000-ops bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 recusa imagem sem aprovação (rejeitada ou launch interrompido)" "não está aprovada" h_image \
  env FAKE_NO_ANCHOR=1 bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 recusa aprovação de outro digest (relatório reescrito ou tag publicada de novo)" "não bate com a aprovação" h_image \
  env FAKE_ANCHOR="$DIGEST_B $DIGEST_C" bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 recusa commit que não é o da tag" "não é o da tag" h_image \
  env FAKE_REPORT_COMMIT="$SECOND" bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 recusa commit que não existe no fork" "não existe no fork" h_image \
  env FAKE_REPORT_COMMIT="${SHORT}000000000000000000000000000000000" bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 recusa versão que não é a do package.json do commit" "tem a versão 0.41.0, não 0.42.0" h_image \
  env FAKE_REPORT_TAG="0.42.0-$SHORT-arm64" FAKE_REPORT_OPS="0.42.0-$SHORT-ops" FAKE_REPORT_VERSION=0.42.0 bash -c 'resolve "$1"' _ "0.42.0-$SHORT-arm64"
expect_refusal "A1 recusa scan que não terminou (fail closed)" "não COMPLETE" h_image \
  env FAKE_SCAN='IN_PROGRESS\tNone' bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 recusa scan ilegível (fail closed)" "não COMPLETE" h_image \
  env FAKE_SCAN=fail bash -c 'resolve "$1"' _ "$TAG"
expect_success "A1 aceita scan não concluído só com BB_SRV_ACCEPT_UNSCANNED=1" "imagem $TAG" h_image \
  env FAKE_SCAN='IN_PROGRESS\tNone' BB_SRV_ACCEPT_UNSCANNED=1 bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 recusa CRITICAL no scan" "CRITICAL" h_image \
  env FAKE_SCAN='COMPLETE\t2' bash -c 'resolve "$1"' _ "$TAG"
expect_refusal "A1 sem --image-tag, a mais nova pede confirmação (mostra o commit)" "commit $FIRST" h_image \
  bash -c 'resolve ""'

# Aprovação pelo Mac (build-image.sh approve): confere o relatório e o hash do código antes de gravar.
expect_calls "A1 approve grava /bb-srv/images/<tag> com os digests do relatório (só com --yes ou 'aprovar')" \
  "WRITE ssm put-parameter --name /bb-srv/images/$TAG --type String --value $DIGEST_A $DIGEST_C" 'NADA' h_image \
  env FAKE_NO_ANCHOR=1 bash scripts/build-image.sh approve "$TAG" --yes
expect_refusal "A1 approve sem terminal nem --yes não grava" "a confirmação precisa de um terminal" h_image \
  env FAKE_NO_ANCHOR=1 bash scripts/build-image.sh approve "$TAG"
expect_refusal "A1 approve recusa relatório com outro hash do código" "dá $SOURCE_HASH" h_image \
  env FAKE_NO_ANCHOR=1 FAKE_REPORT_SOURCE="$(hex64 d)" bash scripts/build-image.sh approve "$TAG" --yes
expect_refusal "A1 approve nunca sobrescreve uma aprovação com outro valor" "já existe com outro valor" h_image \
  env FAKE_ANCHOR="$DIGEST_B $DIGEST_C" bash scripts/build-image.sh approve "$TAG" --yes

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
  env FAKE_STACKS="bb-srv-dns=CREATE_COMPLETE bb-srv-base=CREATE_COMPLETE bb-srv-signal=UPDATE_COMPLETE" FAKE_OUTPUT_HostedZoneName=bb-aws.example.com \
    FAKE_OUTPUT_HostedZoneId=Z123 FAKE_PARAM_SourceCommit="$FIRST" FAKE_PARAM_AcmeEmail=acme@example.com \
    FAKE_PARAM_KEYS="AmiId InstanceType SourceCommit SourceSha256 IngressApproved AcmeEmail" "$@"
}
expect_refusal "B13 atualização recusa outro commit (exige recriar a VM)" "Trocar o commit exige recriar" h_signal \
  signal_env bash scripts/deploy-signal.sh --commit "$SECOND"
expect_refusal "B13 atualização recusa outro e-mail ACME" "Trocar exige recriar" h_signal \
  signal_env bash scripts/deploy-signal.sh --acme-email outro@example.com
expect_calls "B13 fechar as portas usa o template implantado, não resolve AMI nem cota, e mantém a AMI" \
  'WRITE cloudformation create-change-set .*--use-previous-template.*ParameterKey=AmiId,UsePreviousValue=true.*InstanceType,UsePreviousValue=true.*IngressApproved,ParameterValue=false' \
  'ssm get-parameters|service-quotas|s3api head-object|route53|template-body' h_signal signal_env bash scripts/deploy-signal.sh
expect_calls "B13 --instance-type troca só o tamanho e as portas, sobre o template implantado" \
  'WRITE cloudformation create-change-set .*--use-previous-template.*SourceSha256,UsePreviousValue=true.*IngressApproved,ParameterValue=false ParameterKey=InstanceType,ParameterValue=t4g.medium' \
  'template-body|InstanceType,UsePreviousValue' h_signal signal_env bash scripts/deploy-signal.sh --instance-type t4g.medium

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
  'WRITE cloudformation create-change-set .*--use-previous-template.*Sector,UsePreviousValue=true.*AmiId,UsePreviousValue=true.*TerminationProtection,ParameterValue=true ParameterKey=ImageTag,ParameterValue='"$TAG" \
  'template-body|AmiId,ParameterValue' h_failed \
  env FAKE_STACKS="bb-srv-piloto-compute=CREATE_COMPLETE" FAKE_PARAM_KEYS="Sector Size AmiId TerminationProtection ImageTag" \
  bash -c 'source "$0/scripts/lib.sh"; protect_sector piloto "$1"' "$ROOT" "$TAG"

# ---------------------------------------------------------------- C: change set cancelado ou falho (achado 6)
# O create-change-set é simulado (nada vai para a AWS) para chegar à confirmação; o delete-change-set
# e o delete-stack que vêm depois são escritas, recusadas e anotadas pelo aws falso.
h_changeset() {
  case "$1 $2" in
    "cloudformation describe-stacks") fake_cfn "$@" ;;
    "cloudformation create-change-set") echo "arn:aws:cloudformation:us-east-1:358748433479:changeSet/x/y" ;;
    "cloudformation wait") [ "${FAKE_CS_FAILS:-0}" = 0 ] ;;
    "cloudformation describe-change-set")
      case "$*" in *StatusReason*) echo "Template format error: teste" ;; *) echo "Add Volume AWS::EC2::Volume None" ;; esac ;;
    *) return 1 ;;
  esac
}
export -f h_changeset
expect_calls "C6 confirmação recusada numa criação apaga o change set e a stack vazia (REVIEW_IN_PROGRESS)" \
  'WRITE cloudformation delete-stack --stack-name bb-srv-piloto-data' 'execute-change-set' h_changeset \
  env FAKE_AWS_SIMULATE="cloudformation create-change-set" FAKE_STACKS="bb-srv-piloto-data=REVIEW_IN_PROGRESS" \
  bash -c 'source "$0/scripts/lib.sh"; deploy_stack bb-srv-piloto-data "$0/templates/sector-data.yaml" piloto' "$ROOT"
expect_calls "C6 change set falho numa criação também apaga a stack vazia" \
  'WRITE cloudformation delete-stack --stack-name bb-srv-piloto-data' 'execute-change-set' h_changeset \
  env FAKE_AWS_SIMULATE="cloudformation create-change-set" FAKE_CS_FAILS=1 FAKE_STACKS="bb-srv-piloto-data=REVIEW_IN_PROGRESS" \
  bash -c 'source "$0/scripts/lib.sh"; deploy_stack bb-srv-piloto-data "$0/templates/sector-data.yaml" piloto' "$ROOT"
expect_calls "C6 confirmação recusada numa atualização apaga só o change set" \
  'WRITE cloudformation delete-change-set --stack-name bb-srv-piloto-data' 'execute-change-set|delete-stack' h_changeset \
  env FAKE_AWS_SIMULATE="cloudformation create-change-set" FAKE_STACKS="bb-srv-piloto-data=CREATE_COMPLETE" \
  bash -c 'source "$0/scripts/lib.sh"; deploy_stack bb-srv-piloto-data "$0/templates/sector-data.yaml" piloto' "$ROOT"
expect_refusal "C6 update_parameters recusa lista de parâmetros vazia (não aplica os padrões)" "voltou vazia" h_changeset \
  env FAKE_STACKS="bb-srv-base=CREATE_COMPLETE" FAKE_PARAM_KEYS="" bash -c 'source "$0/scripts/lib.sh"; update_parameters bb-srv-base shared ProjectBudgetUsd=110' "$ROOT"
expect_success "C6 sync_project_budget não mexe no budget se a soma falha (list-stacks ilegível)" "não consegui somar" h_changeset \
  env FAKE_STACKS="bb-srv-base=CREATE_COMPLETE" bash -c 'source "$0/scripts/lib.sh"; sync_project_budget' "$ROOT"
expect_calls "C6 remove-sector apaga as stacks vazias de um setor cancelado, sem snapshot" \
  'WRITE cloudformation delete-stack --stack-name bb-srv-piloto-compute' 'create-snapshot|describe-volumes' h_changeset \
  env FAKE_STACKS="bb-srv-piloto-compute=REVIEW_IN_PROGRESS bb-srv-piloto-data=REVIEW_IN_PROGRESS" \
  bash scripts/remove-sector.sh piloto --app-removed --yes
expect_calls "C6 ssm_run para logo quando o send-command falha (sem esperar o timeout)" \
  'WRITE ssm send-command' 'get-command-invocation' h_changeset \
  bash -c 'source "$0/scripts/lib.sh"; ssm_run i-0123456789abcdef0 bb-srv-Status "{}" 30' "$ROOT"

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
EXTRA_STACKS="bb-srv-piloto-compute=REVIEW_IN_PROGRESS" expect_refusal "C6 stack -compute vazia (REVIEW_IN_PROGRESS) conta como inexistente" "rode sem --resume" h_sector \
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

# ---------------------------------------------------------------- D: chave de longa duração (achado 5)
LONG_TERM="arn:aws:iam::358748433479:user/ariel"
expect_refusal "D5 script de escrita recusa chave de longa duração e mostra a sessão com MFA" "role/culturabuilder-admin" h_sector \
  env FAKE_ARN="$LONG_TERM" FAKE_KEY_ID=AKIAFAKEFAKEFAKEFAKE bash scripts/upgrade-sector.sh piloto "$TAG"
expect_refusal "D5 recusa também no deploy-base, antes de qualquer leitura de stack" "este script altera a AWS" h_sector \
  env FAKE_ARN="$LONG_TERM" FAKE_KEY_ID=AKIAFAKEFAKEFAKEFAKE bash scripts/deploy-base.sh --alert-email ops@example.com
expect_refusal "D5 recusa sessão de usuário IAM (ASIA de get-session-token: MFA não comprovável)" "MFA não comprovável" h_sector \
  env FAKE_ARN="$LONG_TERM" FAKE_KEY_ID=ASIAFAKEFAKEFAKEFAKE bash scripts/upgrade-sector.sh piloto "$TAG"
expect_refusal "D5 recusa sessão de uma role fora de config/mfa-roles.txt" "fora de config/mfa-roles.txt" h_sector \
  env FAKE_ARN="arn:aws:sts::358748433479:assumed-role/OutraRole/teste" bash scripts/upgrade-sector.sh piloto "$TAG"
expect_refusal "D5 aceita a role bb-srv-operator (trust com MFA) e segue" "não tem instância" h_sector \
  env FAKE_ARN="arn:aws:sts::358748433479:assumed-role/bb-srv-operator/teste" bash scripts/upgrade-sector.sh piloto "$TAG"
expect_refusal "D5 recusa AWS_CONFIG_FILE num script de escrita" "AWS_CONFIG_FILE está definida" h_sector \
  env AWS_CONFIG_FILE=/dev/null bash scripts/upgrade-sector.sh piloto "$TAG"
expect_refusal "D5 recusa AWS_SHARED_CREDENTIALS_FILE num script de escrita" "AWS_SHARED_CREDENTIALS_FILE está definida" h_sector \
  env AWS_SHARED_CREDENTIALS_FILE=/dev/null bash scripts/upgrade-sector.sh piloto "$TAG"
expect_refusal "D5 recusa endpoint trocado (AWS_ENDPOINT_URL_STS)" "AWS_ENDPOINT_URL_STS está definida" h_sector \
  env AWS_ENDPOINT_URL_STS=http://127.0.0.1:9 bash scripts/status.sh
expect_refusal "D5 aceita a chave de longa duração só com BB_SRV_ALLOW_LONG_TERM_KEY=1" "não tem instância" h_sector \
  env FAKE_ARN="$LONG_TERM" FAKE_KEY_ID=AKIAFAKEFAKEFAKEFAKE BB_SRV_ALLOW_LONG_TERM_KEY=1 bash scripts/upgrade-sector.sh piloto "$TAG"
expect_refusal "D5 recusa a conta root mesmo com BB_SRV_ALLOW_LONG_TERM_KEY=1" "é a conta root" h_sector \
  env FAKE_ARN="arn:aws:iam::358748433479:root" BB_SRV_ALLOW_LONG_TERM_KEY=1 bash scripts/upgrade-sector.sh piloto "$TAG"
h_status() {
  case "$1 $2" in
    "cloudformation describe-stacks") fake_cfn "$@" ;;
    "cloudformation list-stacks") echo "" ;;
    *) return 1 ;;
  esac
}
export -f h_status
expect_success "D5 status.sh (só leitura) só avisa da chave de longa duração" "Os scripts que alteram a AWS a recusam" h_status \
  env FAKE_ARN="$LONG_TERM" FAKE_KEY_ID=AKIAFAKEFAKEFAKEFAKE bash scripts/status.sh

# ---------------------------------------------------------------- D: cota de Elastic IP (achado 8)
h_eip() {
  case "$1 $2" in
    "service-quotas get-service-quota") echo 5.0 ;;
    "ec2 describe-addresses") echo "${FAKE_EIPS:-2}" ;;
    *) return 1 ;;
  esac
}
export -f h_eip
expect_success "D8 aceita EIP com folga (5 de cota, 2 em uso)" "cota de Elastic IPs: 5" h_eip lib check_eip_quota 1
expect_refusal "D8 recusa o EIP que deixaria a conta sem reserva (5 de cota, 4 em uso)" "cota de Elastic IPs (L-0263D0A3)" h_eip \
  env FAKE_EIPS=4 bash -c 'source "$0/scripts/lib.sh"; check_eip_quota 1' "$ROOT"

# ---------------------------------------------------------------- D: sobras da base (achado 16)
h_leftover() {
  case "$1 $2" in
    "cloudformation describe-stacks") fake_cfn "$@" ;;
    "s3api head-bucket") [[ "$*" == *bb-srv-build-* ]] ;;
    "ecr describe-repositories") return 1 ;;
    *) return 1 ;;
  esac
}
export -f h_leftover
expect_refusal "D16 deploy-base recusa criar a base sobre sobras (bucket de build), antes de escrever" "s3://bb-srv-build-358748433479" h_leftover \
  bash scripts/deploy-base.sh --alert-email ops@example.com
expect_refusal "D16 deploy-base exige --alert-email só na criação" "informe --alert-email" h_leftover bash scripts/deploy-base.sh

# ---------------------------------------------------------------- D: zona em stack própria (achado 20)
expect_refusal "D20 deploy-signal exige a stack bb-srv-dns" "bb-srv-dns precisa existir" h_signal \
  env FAKE_STACKS="bb-srv-base=CREATE_COMPLETE" bash scripts/deploy-signal.sh --commit "$FIRST" --acme-email acme@example.com

# ---------------------------------------------------------------- D: limpeza de snapshots (achado 19)
h_gc() {
  case "$1 $2" in
    "cloudformation describe-stacks") fake_cfn "$@" ;;
    "ec2 describe-snapshots")
      printf 'snap-0000000000000000a\t2026-01-01T07:00:00.000Z\tfin\t2020-01-01\tNone\t40\n'
      printf 'snap-0000000000000000b\t2026-01-01T07:00:00.000Z\tfin\t2999-01-01\tNone\t40\n'
      printf 'snap-0000000000000000c\t2026-01-01T07:00:00.000Z\tantigo\tNone\tpolicy-1\t40\n'
      printf 'snap-0000000000000000d\t2999-01-01T07:00:00.000Z\tantigo\tNone\tpolicy-1\t40\n'
      printf 'snap-0000000000000000e\t2026-01-01T07:00:00.000Z\tpiloto\tNone\tpolicy-1\t40\n'
      ;;
    *) return 1 ;;
  esac
}
export -f h_gc
gc_env() { env FAKE_STACKS="bb-srv-piloto-compute=CREATE_COMPLETE bb-srv-piloto-data=CREATE_COMPLETE" "$@"; }
: >"$FAKE_AWS_LOG"
gc_out=$(FAKE_AWS_HANDLER=h_gc gc_env bash scripts/gc-snapshots.sh 2>&1 </dev/null)
if grep -q 'snap-0000000000000000a.*ExpiresAt 2020-01-01' <<<"$gc_out" && grep -q 'snap-0000000000000000c.*DLM de setor removido' <<<"$gc_out" &&
  ! grep -Eq 'snap-0000000000000000[bde]' <<<"$gc_out" && grep -q '2 snapshot(s)' <<<"$gc_out" && ! grep -q '^WRITE' "$FAKE_AWS_LOG"; then
  passed=$((passed + 1)); printf 'ok     %s\n' "D19 gc lista só o vencido e o órfão do DLM de setor removido (sem escrever)"
else
  bad "D19 gc lista só o vencido e o órfão do DLM de setor removido" "$gc_out"
fi
expect_refusal "D19 gc --delete exige a confirmação digitada (sem terminal, para antes de apagar)" "a confirmação precisa de um terminal" h_gc \
  gc_env bash scripts/gc-snapshots.sh --delete

printf '\n%s ok, %s falharam\n' "$passed" "$failed"
[ "$failed" = 0 ]
