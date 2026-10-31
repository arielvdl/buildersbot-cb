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
  env FAKE_STACKS="bb-srv-base=CREATE_COMPLETE bb-srv-ops=CREATE_COMPLETE bb-srv-proxy=CREATE_COMPLETE bb-srv-signal=CREATE_COMPLETE ${EXTRA_STACKS:-}" \
    FAKE_PARAM_Size=large FAKE_OUTPUT_InstanceId=i-0123456789abcdef0 "$@"
}
export EXTRA_STACKS="bb-srv-piloto-compute=CREATE_COMPLETE bb-srv-piloto-data=CREATE_COMPLETE"
expect_refusal "C15 setor existente sem --resume indica o --resume" "scripts/add-sector.sh piloto --resume" h_sector \
  sector_env bash scripts/add-sector.sh piloto
expect_refusal "C15 --resume não troca o tamanho" "não troca o tamanho" h_sector \
  sector_env bash scripts/add-sector.sh piloto medium --resume
expect_refusal "C15 --resume não combina com --from-snapshot" "não combina" h_sector \
  sector_env bash scripts/add-sector.sh piloto --resume --from-snapshot snap-0123456789abcdef0
EXTRA_STACKS='' expect_refusal "C15 --resume sem a stack -compute pede o fluxo normal" "rode sem --resume" h_sector \
  sector_env bash scripts/add-sector.sh piloto --resume
EXTRA_STACKS="bb-srv-piloto-compute=REVIEW_IN_PROGRESS" expect_refusal "C6 stack -compute vazia (REVIEW_IN_PROGRESS) conta como inexistente" "rode sem --resume" h_sector \
  sector_env bash scripts/add-sector.sh piloto --resume

# --resume numa VM nova (troca de VM, restauração): /image existe, mas a marca é de outra VM (achado 4).
h_resume() {
  local name='' prev='' a
  for a in "$@"; do
    [ "$prev" != --name ] || name=$a
    prev=$a
  done
  case "$1 $2" in
    "cloudformation describe-stacks") fake_cfn "$@" ;;
    "ssm get-parameter")
      case $name in
        */installed-instance) [ -n "${FAKE_INSTALLED:-}" ] && echo "$FAKE_INSTALLED" ;;
        /bb-srv/sectors/*/image) echo "x@$DIGEST_A" ;;
        /bb-srv/images/*) echo "$DIGEST_A $DIGEST_C" ;;
        *) return 1 ;;
      esac
      ;;
    "s3 cp" | "ecr describe-images" | "ecr describe-image-scan-findings") h_image "$@" ;;
    "ec2 describe-instances") echo running ;;
    "ec2 describe-volumes") echo 40 ;;
    "ssm describe-instance-information") echo Online ;;
    "ssm describe-parameters") echo SecureString ;;
    *) return 1 ;;
  esac
}
export -f h_resume
resume_env() {
  sector_env FAKE_PARAM_TerminationProtection=false FAKE_OUTPUT_VolumeId=vol-0123456789abcdef0 \
    FAKE_OUTPUT_BuildBucketName=bb-srv-build-358748433479 FAKE_OUTPUT_RepositoryUri=358748433479.dkr.ecr.us-east-1.amazonaws.com/bb-srv/server \
    FAKE_PARAM_KEYS="Sector Size AmiId TerminationProtection ImageTag" "$@"
}
expect_refusal "C15 --resume num setor instalado (nesta VM) e protegido não faz nada" "nada a retomar" h_resume \
  sector_env FAKE_INSTALLED=i-0123456789abcdef0 FAKE_PARAM_TerminationProtection=true bash scripts/add-sector.sh piloto --resume
expect_calls "C15 --resume numa VM nova (marca de outra VM) roda o bb-srv-Install" \
  'WRITE ssm send-command .*--document-name bb-srv-Install' 'create-change-set' h_resume \
  resume_env FAKE_INSTALLED=i-0aaaaaaaaaaaaaaaa bash scripts/add-sector.sh piloto --resume --image-tag "$TAG"
expect_calls "C15 --resume sem marca de instalação roda o bb-srv-Install" \
  'WRITE ssm send-command .*--document-name bb-srv-Install' 'create-change-set' h_resume \
  resume_env bash scripts/add-sector.sh piloto --resume --image-tag "$TAG"
expect_calls "C15 --resume com a marca DESTA VM só liga a proteção" \
  'WRITE cloudformation create-change-set .*TerminationProtection,ParameterValue=true' 'send-command' h_resume \
  resume_env FAKE_INSTALLED=i-0123456789abcdef0 bash scripts/add-sector.sh piloto --resume

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

# ---------------------------------------------------------------- D: cota de vCPU com setores parados (achado 7)
# Cota 64; ligadas 44 vCPU (2 x m5.4xlarge e 6 x t3.large); 3 setores t4g.large parados (6 vCPU).
h_vcpu() {
  case "$1 $2" in
    "service-quotas get-service-quota") echo 64.0 ;;
    "ec2 describe-instances")
      case "$*" in
        *stopped*) [ "${FAKE_PARKED:-1}" = 0 ] || printf 't4g.large\t2\t1\nt4g.large\t2\t1\nt4g.large\t2\t1\n' ;;
        *) printf 'm5.4xlarge\t8\t2\nm5.4xlarge\t8\t2\n'; for _ in 1 2 3 4 5 6; do printf 't3.large\t1\t2\n'; done ;;
      esac
      ;;
    *) return 1 ;;
  esac
}
export -f h_vcpu
expect_refusal "D7 cota de vCPU conta os setores parados (64 - 44 ligadas - 6 paradas - 2 = 12 < 16)" "setores parados (voltam a ligar): 6" h_vcpu \
  bash -c 'source "$0/scripts/lib.sh"; check_vcpu_quota 2' "$ROOT"
expect_success "D7 controle: sem setores parados sobra 18 e passa" "depois desta operação: 18 livres" h_vcpu \
  env FAKE_PARKED=0 bash -c 'source "$0/scripts/lib.sh"; check_vcpu_quota 2' "$ROOT"

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

# ---------------------------------------------------------------- E: imagem em uso e acesso do operador (revisão de segurança automática)
# A saída do SSM mistura passos que não são de confiança: vale uma única linha BB_IMAGE e só do nosso ECR.
REPO_T=358748433479.dkr.ecr.us-east-1.amazonaws.com/bb-srv/server
IMG_T=$REPO_T@$DIGEST_A
expect_parse() { # <nome> <ok | texto esperado do erro> <saída do SSM> <repositório>
  local name=$1 expect=$2 out status
  out=$(lib parse_running_image "$3" "$4" 2>&1)
  status=$?
  if [ "$expect" = ok ]; then
    if [ "$status" = 0 ] && [ "$out" = "$IMG_T" ]; then
      passed=$((passed + 1)); printf 'ok     %s\n' "$name"
    else
      bad "$name: esperava devolver a imagem" "$out"
    fi
  elif [ "$status" != 0 ] && grep -qF -- "$expect" <<<"$out"; then
    passed=$((passed + 1)); printf 'ok     %s\n' "$name"
  else
    bad "$name: esperava recusa com '$expect' (status $status)" "$out"
  fi
}
expect_parse "E1 aceita uma única linha BB_IMAGE do nosso ECR" ok $'passo 1\nBB_IMAGE '"$IMG_T"$'\nfim' "$REPO_T"
expect_parse "E1 recusa saída sem BB_IMAGE" "achei 0" $'passo 1\nfim' "$REPO_T"
expect_parse "E1 recusa duas linhas BB_IMAGE (a última não ganha)" "achei 2" $'BB_IMAGE '"$IMG_T"$'\nBB_IMAGE '"$REPO_T@$DIGEST_B" "$REPO_T"
expect_parse "E1 recusa linha forjada antes da verdadeira" "achei 2" $'BB_IMAGE evil.example.com/x@'"$DIGEST_B"$'\nBB_IMAGE '"$IMG_T" "$REPO_T"
expect_parse "E1 recusa registro de outro dono" "não é do repositório ECR do projeto" $'BB_IMAGE evil.example.com/bb-srv/server@'"$DIGEST_A" "$REPO_T"
expect_parse "E1 recusa repositório vizinho de nome parecido" "não é do repositório ECR do projeto" $'BB_IMAGE '"$REPO_T"'-evil@'"$DIGEST_A" "$REPO_T"
expect_parse "E1 recusa digest malformado" "digest sha256 válido" $'BB_IMAGE '"$REPO_T"'@sha256:abc' "$REPO_T"

# O operador só alcança VMs de setor (Role=sector-host): a VM do Signal (4 segredos) e o builder ficam para o administrador.
role_conditions=$(grep -c "'ssm:resourceTag/Role': sector-host" templates/base.yaml)
if [ "$role_conditions" = 2 ] && grep -q "{Key: Role, Value: sector-host}" templates/sector-compute.yaml &&
  grep -q "{Key: Role, Value: signal}" templates/signal.yaml; then
  passed=$((passed + 1)); printf 'ok     %s\n' "E2 o operador só abre sessão e comando em VM com Role=sector-host (Signal fora)"
else
  bad "E2 o operador só abre sessão e comando em VM com Role=sector-host" "condições no base.yaml: $role_conditions (esperava 2)"
fi

# A AWS só aceita scripts (pré e pós) em UM agendamento por política do DLM: a primeira criação do bb-srv-ops
# falhou com ServiceLimitExceeded por isso, e o validate-template não pega. O teste lê o template.
dlm_scripts=$(awk '/^  [A-Za-z0-9]+:$/ {name=$1} /Type: AWS::DLM::LifecyclePolicy/ {dlm[name]=1} /^ *Scripts:/ {n[name]++} END {for (k in dlm) if (n[k] > 1) print k, n[k]}' templates/ops.yaml)
if [ -z "$dlm_scripts" ] && [ "$(grep -c 'Type: AWS::DLM::LifecyclePolicy' templates/ops.yaml)" -ge 3 ]; then
  passed=$((passed + 1)); printf 'ok     %s\n' "E3 cada política do DLM tem scripts em no máximo um agendamento"
else
  bad "E3 cada política do DLM tem scripts em no máximo um agendamento" "políticas com mais de um agendamento com scripts: $dlm_scripts"
fi

# ---------------------------------------------------------------- F: proxy de saída residencial (README, seção 16)
# Valores falsos (TEST-NET): o valor real de /bb-srv/proxy/egress nunca entra em teste, log ou commit.
ok_case() {
  passed=$((passed + 1))
  printf 'ok     %s\n' "$1"
}
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# A ferramenta do host, extraída do documento bb-srv-ProxySetup exatamente como o host a grava (o
# heredoc 'BBSRVPROXY', sem a indentação do YAML). Aqui rodam só os modos sem efeito no sistema.
TOOL=$WORK/bb-srv-proxy
awk -v m=BBSRVPROXY '
  !on && index($0, "<<\047" m "\047") { on = 1; match($0, /^ */); ind = RLENGTH; next }
  on { line = $0; if (substr(line, 1, ind) ~ /^ *$/) line = substr(line, ind + 1); if (line == m) exit; print line }
' templates/proxy.yaml >"$TOOL"
if [ "$(head -n 1 "$TOOL")" = '#!/bin/bash' ] && grep -q '^case \${1:-} in$' "$TOOL" && bash -n "$TOOL" &&
  { ! command -v shellcheck >/dev/null || shellcheck -s bash "$TOOL"; }; then
  ok_case "F0 a ferramenta bb-srv-proxy (templates/proxy.yaml) sai inteira do YAML e passa em bash -n e shellcheck"
else
  bad "F0 a ferramenta bb-srv-proxy sai inteira do YAML e passa em bash -n e shellcheck"
fi

# parse: host:porta:usuário:senha (só os três primeiros ":" separam) -> configuração do tinyproxy, 0600.
UPSTREAM_T=$WORK/upstream.conf
expect_upstream() { # <nome> <valor> <linha Upstream esperada>
  local msg status
  rm -f "$UPSTREAM_T"
  msg=$(printf '%s' "$2" | bash "$TOOL" parse "$UPSTREAM_T" 2>&1)
  status=$?
  if [ "$status" = 0 ] && [ -z "$msg" ] && grep -qxF "$3" "$UPSTREAM_T" && grep -qx 'Listen 172.30.0.1' "$UPSTREAM_T" &&
    grep -qx 'Allow 172.30.0.0/16' "$UPSTREAM_T" && grep -qx 'LogLevel Warning' "$UPSTREAM_T" &&
    grep -qx 'ConnectPort 443' "$UPSTREAM_T" && [ "$(grep -c '^Upstream ' "$UPSTREAM_T")" = 1 ] &&
    [ "$(file_mode "$UPSTREAM_T")" = 600 ]; then
    ok_case "$1"
  else
    bad "$1 (status $status, modo $(file_mode "$UPSTREAM_T" 2>/dev/null))" "$msg"
  fi
}
# <nome> <valor> <texto esperado>: recusa, mensagem sem nenhuma parte do valor, arquivo anterior intacto
# e nenhum temporário deixado para trás.
expect_upstream_refused() {
  local msg status secret
  printf 'anterior\n' >"$UPSTREAM_T"
  msg=$(printf '%s' "$2" | bash "$TOOL" parse "$UPSTREAM_T" 2>&1)
  status=$?
  secret=''
  case $msg in *s3cr3t-Pa55* | *demo-user* | *203.0.113.10*) secret=1 ;; esac
  if [ "$status" != 0 ] && grep -qF -- "$3" <<<"$msg" && [ -z "$secret" ] && [ "$(cat "$UPSTREAM_T")" = anterior ] &&
    [ -z "$(find "$WORK" -maxdepth 1 -name 'upstream.conf.*' -print -quit)" ]; then
    ok_case "$1"
  else
    bad "$1 (status $status)" "$msg"
  fi
}
expect_upstream "F1 parse aceita host:porta:usuário:senha (IPv4 público)" \
  '203.0.113.10:8080:demo-user:demo-pass' 'Upstream http demo-user:demo-pass@203.0.113.10:8080'
expect_upstream "F1 parse mantém os ':' da senha (só os três primeiros separam)" \
  'proxy.example.net:12321:demo-user:pa:ss:wo:rd' 'Upstream http demo-user:pa:ss:wo:rd@proxy.example.net:12321'
expect_upstream_refused "F1 parse recusa valor com três partes" '203.0.113.10:8080:demo-user' "four parts"
expect_upstream_refused "F1 parse recusa valor vazio" '' "is empty"
expect_upstream_refused "F1 parse recusa valor de duas linhas" $'203.0.113.10:8080:demo-user:s3cr3t-Pa55\nx' "more than one line"
expect_upstream_refused "F1 parse recusa porta 0" '203.0.113.10:0:demo-user:s3cr3t-Pa55' "the port"
expect_upstream_refused "F1 parse recusa porta 65536" '203.0.113.10:65536:demo-user:s3cr3t-Pa55' "the port"
expect_upstream_refused "F1 parse recusa porta não numérica" '203.0.113.10:80a:demo-user:s3cr3t-Pa55' "the port"
expect_upstream_refused "F1 parse recusa host privado (10/8)" '10.0.0.5:8080:demo-user:s3cr3t-Pa55' "the host"
expect_upstream_refused "F1 parse recusa o IMDS como host" '169.254.169.254:80:demo-user:s3cr3t-Pa55' "the host"
expect_upstream_refused "F1 parse recusa localhost" 'localhost:8080:demo-user:s3cr3t-Pa55' "the host"
expect_upstream_refused "F1 parse recusa host com espaço" 'proxy example.net:8080:demo-user:s3cr3t-Pa55' "the host"
expect_upstream_refused "F1 parse recusa IPv6 (o tinyproxy não o aceita no Upstream)" '[2001:db8::1]:8080:demo-user:s3cr3t-Pa55' "the host"
expect_upstream_refused "F1 parse recusa usuário vazio" '203.0.113.10:8080::s3cr3t-Pa55' "the user"
expect_upstream_refused "F1 parse recusa usuário com @" '203.0.113.10:8080:demo@user:s3cr3t-Pa55' "the user"
expect_upstream_refused "F1 parse recusa senha vazia" '203.0.113.10:8080:demo-user:' "the password"
expect_upstream_refused "F1 parse recusa senha com @ (o tinyproxy corta no @)" '203.0.113.10:8080:demo-user:s3cr3t@Pa55' "cannot contain @"
expect_upstream_refused "F1 parse recusa senha com espaço" '203.0.113.10:8080:demo-user:s3cr3t Pa55' "the password"
expect_upstream_refused "F1 parse recusa valor com mais de 700 caracteres" "203.0.113.10:8080:demo-user:$(hex64 a)$(hex64 b)$(hex64 c)$(hex64 d)$(hex64 e)$(hex64 f)$(hex64 1)$(hex64 2)$(hex64 3)$(hex64 4)$(hex64 5)" "longer than 700"

# classify: a linha de saúde tem o país, nunca um endereço.
expect_classify() { # <nome> <rc do curl> <código CONNECT> <resposta> <linha esperada>
  local out
  out=$(printf '%b' "$4" | bash "$TOOL" classify "$2" "$3" 2>&1)
  if [ "$out" = "$5" ] && ! grep -q '198\.51\.100' <<<"$out"; then ok_case "$1"; else bad "$1" "$out"; fi
}
expect_classify "F2 saúde: resposta do Brasil vira 'ok BR' (sem o IP)" 0 200 'fl=1\nip=198.51.100.7\nloc=BR\n' "ok BR"
expect_classify "F2 saúde: outro país vira 'ok US' (o alarme só conta BR)" 0 200 'ip=198.51.100.7\nloc=US\n' "ok US"
expect_classify "F2 saúde: senha recusada pelo proxy vira 'fail connect-407'" 56 407 '' "fail connect-407"
expect_classify "F2 saúde: encaminhador fora vira 'fail forwarder-unreachable'" 7 000 '' "fail forwarder-unreachable"
expect_classify "F2 saúde: tempo esgotado vira 'fail timeout'" 28 000 '' "fail timeout"
expect_classify "F2 saúde: resposta sem país vira 'fail no-country'" 0 200 'ip=198.51.100.7\n' "fail no-country"

# classify-direct: o teste de saída direta (curl a um IP literal, da rede do contêiner) só diz "blocked" sem
# conexão (7) ou por tempo esgotado (28). Conectou (time_connect > 0) = aberto, mesmo com erro de TLS depois.
expect_direct() { # <nome> <rc do curl> <time_connect> <esperado>
  local out
  out=$(bash "$TOOL" classify-direct "$2" "$3" 2>&1)
  if [ "$out" = "$4" ]; then ok_case "$1"; else bad "$1" "$out"; fi
}
expect_direct "F2 saída direta: tempo esgotado sem conexão é 'blocked'" 28 0.000000 blocked
expect_direct "F2 saída direta: conexão recusada é 'blocked'" 7 0.000000 blocked
expect_direct "F2 saída direta: resposta é 'OPEN'" 0 0.031200 OPEN
expect_direct "F2 saída direta: erro de TLS depois de conectar é 'OPEN'" 35 0.012000 OPEN
expect_direct "F2 saída direta: tempo esgotado depois de conectar é 'OPEN'" 28 0.020000 OPEN
expect_direct "F2 saída direta: erro de DNS não vale como bloqueio" 6 0.000000 "unknown rc=6"
expect_direct "F2 saída direta: curl ausente não vale como bloqueio" 127 '' "unknown rc=127"

# rules: falha fechada. Com o proxy, o contêiner só sai para o Signal/TURN; o resto cai no DROP final.
rules_proxy=$(bash "$TOOL" rules proxy 12321 203.0.113.7 10.0.0.1 2>&1)
egress_rules=$(grep -- '^-A BB-SRV-EGRESS ' <<<"$rules_proxy")
if grep -qxF -- '-A BB-SRV-EGRESS -d 203.0.113.7/32 -p tcp -m multiport --dports 443,3478,5349 -j RETURN' <<<"$egress_rules" &&
  grep -qxF -- '-A BB-SRV-EGRESS -d 203.0.113.7/32 -p udp -m multiport --dports 3478,49152:65535 -j RETURN' <<<"$egress_rules" &&
  grep -qxF -- '-A BB-SRV-INPUT -d 172.30.0.1/32 -p tcp -m tcp --dport 3128 -j ACCEPT' <<<"$rules_proxy" &&
  grep -qxF -- '-A BB-SRV-INPUT -d 172.30.0.1/32 -p udp -m udp --dport 53 -j ACCEPT' <<<"$rules_proxy" &&
  [ "$(tail -n 1 <<<"$egress_rules")" = '-A BB-SRV-EGRESS -j DROP' ] && ! grep -q '10\.0\.0\.1' <<<"$rules_proxy" &&
  [ "$(grep -c -- '-j RETURN$' <<<"$egress_rules")" = 2 ]; then
  ok_case "F3 firewall com proxy: só o encaminhador, o DNS do host e o Signal/TURN; DROP no fim; IP privado ignorado"
else
  bad "F3 firewall com proxy" "$rules_proxy"
fi
# O próprio encaminhador (OUTPUT do usuário bb-proxy): só o resolvedor do host, os clientes da ponte e a porta
# do upstream. Um tinyproxy comprometido não vira proxy direto com o IP da AWS.
fwd_expected=$'-A BB-SRV-PROXY-OUT -o lo -j RETURN\n-A BB-SRV-PROXY-OUT -d 172.30.0.0/16 -j RETURN\n-A BB-SRV-PROXY-OUT -p tcp -m tcp --dport 12321 -j RETURN\n-A BB-SRV-PROXY-OUT -j REJECT --reject-with icmp-port-unreachable'
if [ "$(grep -- '^-A BB-SRV-PROXY-OUT ' <<<"$rules_proxy")" = "$fwd_expected" ] &&
  [ "$(bash "$TOOL" rules proxy - 203.0.113.7 | grep -c -- '--dport [0-9]* -j RETURN$')" = 0 ] &&
  [ "$(bash "$TOOL" rules proxy '12321 -j ACCEPT' 203.0.113.7 | grep -c 'PROXY-OUT.*dport')" = 0 ]; then
  ok_case "F3 encaminhador confinado: lo, a ponte e a porta do upstream; REJECT no resto (sem porta válida, nada sai)"
else
  bad "F3 encaminhador confinado" "$rules_proxy"
fi
rules_direct=$(bash "$TOOL" rules direct - 203.0.113.7 2>&1)
if ! grep -q 'BB-SRV-EGRESS\|BB-SRV-PROXY-OUT\|--dport 3128' <<<"$rules_direct" && grep -q -- '--dport 53 -j ACCEPT' <<<"$rules_direct"; then
  ok_case "F3 firewall sem proxy (decisão do dono): sem DROP próprio nem encaminhador, só o DNS do contêiner"
else
  bad "F3 firewall sem proxy" "$rules_direct"
fi
# A porta do upstream sai da configuração do tinyproxy sem nada do resto da linha (usuário e senha).
printf '%s' 'proxy.example.net:12321:demo-user:pa:ss:wo:rd' | bash "$TOOL" parse "$UPSTREAM_T" 2>/dev/null
port_out=$(bash "$TOOL" upstream-port "$UPSTREAM_T" 2>&1)
if [ "$port_out" = 12321 ] && [ "$(bash "$TOOL" upstream-port "$WORK/nao-existe.conf" 2>&1)" = - ]; then
  ok_case "F3 porta do upstream lida da configuração (12321), sem usuário nem senha; sem arquivo, nenhuma porta"
else
  bad "F3 porta do upstream" "$port_out"
fi

# env: o que o contêiner recebe (env_file do compose.yaml). Sem usuário nem senha.
in_list() { # <lista separada por vírgulas> <item>...: todos os itens estão na lista
  local list=",$1," item
  shift
  for item in "$@"; do
    case $list in *",$item,"*) ;; *) return 1 ;; esac
  done
}
env_proxy=$(bash "$TOOL" env proxy bb-aws.example.com 203.0.113.7 2>&1)
no_proxy_line=$(sed -n 's/^NO_PROXY=//p' <<<"$env_proxy")
if grep -qx 'HTTPS_PROXY=http://172.30.0.1:3128' <<<"$env_proxy" && grep -qx 'https_proxy=http://172.30.0.1:3128' <<<"$env_proxy" &&
  grep -qx 'ALL_PROXY=http://172.30.0.1:3128' <<<"$env_proxy" && grep -qx 'NODE_USE_ENV_PROXY=1' <<<"$env_proxy" &&
  grep -q '^no_proxy=' <<<"$env_proxy" && ! grep -q '@' <<<"$env_proxy" &&
  in_list "$no_proxy_line" localhost 127.0.0.1 ::1 10.0.0.0/8 169.254.0.0/16 signal.bb-aws.example.com \
    turn.bb-aws.example.com 203.0.113.7; then
  ok_case "F4 o contêiner recebe HTTP(S)_PROXY, ALL_PROXY, NODE_USE_ENV_PROXY=1 e NO_PROXY com loopback, privados e o Signal/TURN"
else
  bad "F4 variáveis do proxy no contêiner" "$env_proxy"
fi
if ! grep -q 'PROXY=' <<<"$(bash "$TOOL" env direct bb-aws.example.com 2>&1)"; then
  ok_case "F4 setor sem proxy (decisão do dono): proxy.env sem variáveis"
else
  bad "F4 setor sem proxy: proxy.env sem variáveis"
fi

# dns-unit: o DNS do contêiner. Com o proxy, só signal./turn. da zona saem (pelo resolvedor do host) e o
# resto recebe NXDOMAIN ali mesmo: nenhuma consulta do contêiner chega a um resolvedor de fora.
dns_proxy=$(bash "$TOOL" dns-unit proxy bb-aws.example.com 2>&1)
dns_exec=$(sed -n 's/^ExecStart=//p' <<<"$dns_proxy")
dns_ok=1
for word in /usr/sbin/dnsmasq --no-resolv --no-hosts --listen-address=172.30.0.1 --bind-dynamic --pid-file= \
  --conf-file=/dev/null --server=/signal.bb-aws.example.com/127.0.0.53 --server=/turn.bb-aws.example.com/127.0.0.53 \
  --address=/#/; do
  case " $dns_exec " in *" $word "*) ;; *) dns_ok=0 ;; esac
done
[ "$(grep -o -- '--server=' <<<"$dns_exec" | wc -l | tr -d ' ')" = 2 ] || dns_ok=0
for line in 'DynamicUser=yes' 'IPAddressDeny=any' 'IPAddressAllow=localhost 172.30.0.0/16' 'LimitCORE=0' \
  'CapabilityBoundingSet=CAP_NET_BIND_SERVICE' 'Before=docker.service' 'WantedBy=multi-user.target'; do
  grep -qxF -- "$line" <<<"$dns_proxy" || dns_ok=0
done
if [ "$dns_ok" = 1 ]; then
  ok_case "F4 DNS do contêiner com proxy: só signal./turn. da zona, NXDOMAIN para o resto, sem rede além do host e da ponte"
else
  bad "F4 DNS do contêiner com proxy" "$dns_proxy"
fi
dns_direct=$(bash "$TOOL" dns-unit direct bb-aws.example.com 2>&1)
if grep -q -- ' --server=127.0.0.53$' <<<"$dns_direct" && ! grep -q -- '--address=' <<<"$dns_direct"; then
  ok_case "F4 DNS do contêiner sem proxy (decisão do dono): todos os nomes vão ao resolvedor do host"
else
  bad "F4 DNS do contêiner sem proxy" "$dns_direct"
fi
if ! bash "$TOOL" dns-unit proxy 'bb-aws.example.com/127.0.0.1 --address=/x' >/dev/null 2>&1; then
  ok_case "F4 DNS do contêiner recusa zona que não é nome DNS (nada entra na linha do dnsmasq)"
else
  bad "F4 DNS do contêiner recusa zona inválida"
fi
# O encaminhador: usuário fixo (a regra de OUTPUT o segue), credencial por LoadCredential, sem core dump. O
# filtro de syscalls começa pela lista permitida: um "~" antes inverteria o filtro.
fwd_unit=$(bash "$TOOL" forwarder-unit 2>&1)
fwd_ok=1
for line in 'User=bb-proxy' 'DynamicUser=yes' 'LoadCredential=tinyproxy.conf:/etc/bb-proxy/upstream.conf' 'LimitCORE=0' \
  'ExecStart=/usr/bin/tinyproxy -d -c %d/tinyproxy.conf' 'Restart=always' 'CapabilityBoundingSet=' 'NoNewPrivileges=yes' \
  'IPAddressDeny=link-local multicast 10.0.0.0/8 100.64.0.0/10 172.16.0.0/12 192.168.0.0/16' 'StartLimitIntervalSec=0'; do
  grep -qxF -- "$line" <<<"$fwd_unit" || fwd_ok=0
done
[ "$(grep '^SystemCallFilter=' <<<"$fwd_unit" | cut -d= -f2 | tr '\n' ' ')" = '@system-service ~@privileged ' ] || fwd_ok=0
[ "$(grep -m 1 '^SystemCallFilter=' <<<"$dns_proxy")" = 'SystemCallFilter=@system-service' ] || fwd_ok=0
! grep -q 'Wants=bb-proxy-config' <<<"$fwd_unit" || fwd_ok=0
if [ "$fwd_ok" = 1 ]; then
  ok_case "F4 unidade do encaminhador: usuário bb-proxy, LoadCredential, sem core dump, filtro de syscalls na ordem certa"
else
  bad "F4 unidade do encaminhador" "$fwd_unit"
fi

# adopt-mode: a primeira resposta da stack fixa a saída da VM. Um "direct" depois (put-parameter, update da
# stack) não abre o contêiner: a saída muda só com uma VM nova (--reattach).
EGRESS_T=$WORK/egress
printf 'proxy\n' >"$EGRESS_T"
adopt_msg=$(bash "$TOOL" adopt-mode "$EGRESS_T" direct 2>&1)
if [ "$(cat "$EGRESS_T")" = proxy ] && grep -q 'changes only with a new VM' <<<"$adopt_msg"; then
  ok_case "F4 VM em proxy continua em proxy quando o SSM passa a responder 'direct' (aviso, nada muda)"
else
  bad "F4 VM em proxy não pode virar direct sem VM nova" "$adopt_msg"
fi
rm -f "$EGRESS_T"
bash "$TOOL" adopt-mode "$EGRESS_T" direct >/dev/null 2>&1
first_direct=$(cat "$EGRESS_T" 2>/dev/null)
rm -f "$EGRESS_T"
bash "$TOOL" adopt-mode "$EGRESS_T" required >/dev/null 2>&1
if [ "$first_direct" = direct ] && [ "$(cat "$EGRESS_T" 2>/dev/null)" = proxy ]; then
  ok_case "F4 VM nova adota a saída da stack na primeira resposta (direct ou proxy)"
else
  bad "F4 VM nova adota a saída da stack" "$first_direct / $(cat "$EGRESS_T" 2>/dev/null)"
fi

# add-sector: proxy obrigatório. Só describe-parameters (existência e tipo); o valor nunca é lido.
h_proxy() {
  case "$1 $2" in
    "cloudformation describe-stacks") fake_cfn "$@" ;;
    "ssm describe-parameters") [ "${FAKE_PROXY_TYPE:-SecureString}" != fail ] && echo "${FAKE_PROXY_TYPE:-SecureString}" ;;
    *) return 1 ;;
  esac
}
export -f h_proxy
EXTRA_STACKS='' expect_refusal "F5 add-sector recusa criar o setor sem /bb-srv/proxy/egress (antes de qualquer escrita)" \
  "falta o parâmetro /bb-srv/proxy/egress" h_proxy sector_env FAKE_PROXY_TYPE=None bash scripts/add-sector.sh piloto --az a
EXTRA_STACKS='' expect_calls "F5 add-sector confere o parâmetro só por describe-parameters (nunca get-parameter)" \
  'ssm describe-parameters' 'ssm get-parameter|WRITE' h_proxy sector_env FAKE_PROXY_TYPE=None bash scripts/add-sector.sh piloto --az a
EXTRA_STACKS='' expect_refusal "F5 add-sector recusa o parâmetro em texto puro (String)" "não SecureString" h_proxy \
  sector_env FAKE_PROXY_TYPE=String bash scripts/add-sector.sh piloto --az a
EXTRA_STACKS='' expect_refusal "F5 add-sector recusa quando não consegue conferir o parâmetro" "não consegui conferir" h_proxy \
  sector_env FAKE_PROXY_TYPE=fail bash scripts/add-sector.sh piloto --az a
EXTRA_STACKS='' expect_calls "F5 add-sector com o parâmetro SecureString segue para a cota (sem ler o valor)" \
  'service-quotas get-service-quota' 'ssm get-parameter|WRITE' h_proxy sector_env bash scripts/add-sector.sh piloto --az a
EXTRA_STACKS='' expect_refusal "F5 --egress-direct exige a confirmação digitada, mesmo com --yes" "a confirmação precisa de um terminal" h_proxy \
  sector_env FAKE_PROXY_TYPE=None bash scripts/add-sector.sh piloto --az a --egress-direct --yes
expect_refusal "F5 --resume não troca a saída do setor" "não troca a saída" h_proxy \
  sector_env bash scripts/add-sector.sh piloto --resume --egress-direct
EXTRA_STACKS='bb-srv-piloto-compute=CREATE_COMPLETE bb-srv-piloto-data=CREATE_COMPLETE' expect_refusal \
  "F5 add-sector exige a stack bb-srv-proxy (documentos do proxy)" "bb-srv-proxy precisa existir" h_proxy \
  env FAKE_STACKS="bb-srv-base=CREATE_COMPLETE bb-srv-ops=CREATE_COMPLETE" bash scripts/add-sector.sh piloto --az a

# status.sh --deep: o veredito sobre as linhas BB_PROXY_* do bb-srv-Status (saída que passa pelo contêiner).
expect_verdict() { # <nome> <saída do bb-srv-Status> <EgressProxy> <texto esperado> [texto proibido]
  local out
  out=$(lib proxy_verdict "$2" piloto "$3" 2>&1)
  if grep -qF -- "$4" <<<"$out" && { [ -z "${5:-}" ] || ! grep -qF -- "$5" <<<"$out"; }; then ok_case "$1"; else bad "$1" "$out"; fi
}
OK_LINES=$'BB_PROXY_MODE proxy\nBB_PROXY_ENV ok\nBB_PROXY_EXIT ip=198.51.100.7 country=BR\nBB_PROXY_DIRECT blocked'
expect_verdict "F6 status --deep mostra o IP e o país vistos de dentro do contêiner" "$OK_LINES" required "IP 198.51.100.7, país BR (proxy residencial ok)"
expect_verdict "F6 status --deep diz que a saída direta está bloqueada" "$OK_LINES" required "saída direta bloqueada"
expect_verdict "F6 status --deep avisa PAÍS ERRADO" "${OK_LINES/country=BR/country=US}" required "PAÍS ERRADO: a saída do contêiner é 198.51.100.7 (US)"
expect_verdict "F6 status --deep avisa contêiner sem as variáveis do proxy" $'BB_PROXY_MODE proxy\nBB_PROXY_ENV missing\nBB_PROXY_EXIT fail\nBB_PROXY_DIRECT blocked' \
  required "PROXY AUSENTE NO CONTÊINER"
expect_verdict "F6 status --deep avisa proxy sem resposta" $'BB_PROXY_MODE proxy\nBB_PROXY_ENV ok\nBB_PROXY_EXIT fail\nBB_PROXY_DIRECT blocked' \
  required "PROXY SEM RESPOSTA"
expect_verdict "F6 status --deep avisa host sem o proxy instalado" 'BB_PROXY_MODE not-installed' required "PROXY AUSENTE: o host não tem"
expect_verdict "F6 status --deep avisa SAÍDA DIRETA ABERTA" "${OK_LINES/blocked/OPEN}" required "SAÍDA DIRETA ABERTA"
expect_verdict "F6 status --deep não repete linha forjada pelo contêiner" \
  $'BB_PROXY_MODE proxy\nBB_PROXY_ENV ok\nBB_PROXY_EXIT ip=1.2.3.4;id country=BR\nBB_PROXY_DIRECT blocked' required "PROXY SEM RESPOSTA" "1.2.3.4;id"
expect_verdict "F6 status --deep de setor sem proxy (decisão do dono) diz que está desligado" "$OK_LINES" direct "DESLIGADO neste setor"

# F9 judge: o veredito do bb-srv-Install e do bb-srv-ProxySetup sobre as linhas do check-container. Um
# vazamento (saída direta não provada bloqueada, DNS que resolve nome de fora) para o contêiner.
expect_judge() { # <nome> <linhas> <veredito esperado>
  local out
  out=$(printf '%s\n' "$2" | bash "$TOOL" judge 2>&1)
  if [ "$out" = "$3" ]; then ok_case "$1"; else bad "$1" "$out"; fi
}
CHK_OK=$'BB_PROXY_MODE proxy\nBB_PROXY_ENV ok\nBB_PROXY_EXIT country=BR\nBB_PROXY_DIRECT blocked\nBB_PROXY_DNS_FILTER ok\nBB_PROXY_DNS ok\nBB_PROXY_SIGNAL ok'
expect_judge "F9 tudo certo: ok" "$CHK_OK" ok
expect_judge "F9 Signal ainda sem stack (DNS e Signal pulados): ok" \
  "${CHK_OK/BB_PROXY_DNS ok/BB_PROXY_DNS skipped}"$'\n'"BB_PROXY_SIGNAL skipped" ok
expect_judge "F9 Signal fora do alcance também do host (portas fechadas): ok, só aviso" "${CHK_OK/SIGNAL ok/SIGNAL unreachable}" ok
expect_judge "F9 saída direta aberta: vazamento" "${CHK_OK/DIRECT blocked/DIRECT OPEN}" "leak direct"
expect_judge "F9 saída direta não conferida (unknown): vazamento até prova" "${CHK_OK/DIRECT blocked/DIRECT unknown rc=6}" "leak direct"
expect_judge "F9 sem a linha da saída direta: vazamento até prova" "${CHK_OK/BB_PROXY_DIRECT blocked/}" "leak direct"
expect_judge "F9 DNS do contêiner resolve nome de fora: vazamento" "${CHK_OK/DNS_FILTER ok/DNS_FILTER OPEN}" "leak dns"
expect_judge "F9 contêiner não resolve o Signal: falha" "${CHK_OK/BB_PROXY_DNS ok/BB_PROXY_DNS fail}" "fail dns"
expect_judge "F9 host alcança o Signal e o contêiner não: falha" "${CHK_OK/SIGNAL ok/SIGNAL fail}" "fail signal"
expect_judge "F9 contêiner sem as variáveis: falha" "${CHK_OK/ENV ok/ENV missing}" "fail env"
expect_judge "F9 saída fora do Brasil: falha" "${CHK_OK/country=BR/country=US}" "fail exit"
expect_judge "F9 contêiner parado" $'BB_PROXY_MODE proxy\nBB_PROXY_CONTAINER down' down
expect_judge "F9 setor sem proxy (decisão do dono)" 'BB_PROXY_MODE direct' direct

# Leituras estáticas dos templates: quem lê a credencial, o que o host liga e a ordem das coisas.
static_fail=''
check() { "$@" >/dev/null 2>&1 || static_fail="$static_fail | $*"; }
# Só a role do setor (e o boundary dela) lê /bb-srv/proxy/*; o operador tem Deny; Signal e builder nada.
check test "$(grep -c "parameter/bb-srv/proxy/\*'" templates/sector-compute.yaml)" = 4
check test "$(grep -c "parameter/bb-srv/proxy/\*'" templates/base.yaml)" = 3
check grep -q 'Sid: DenyProxyCredential' templates/base.yaml
check grep -q "parameter/bb-srv/sectors/\*/egress'" templates/base.yaml
check test "$(grep -c 'bb-srv/proxy' templates/signal.yaml)" = 0
# O valor só é lido por bb-srv-proxy config (uma chamada com --with-decryption) e nunca no user data.
check test "$(grep -c -- '--with-decryption' templates/proxy.yaml)" = 1
check test "$(grep -c -- '--with-decryption' templates/ops.yaml)" = 0
check test "$(grep -c 'with-decryption\|get-parameter' templates/sector-compute.yaml)" = 0
check test "$(grep -cE '(^|[[:space:]])set -x' templates/proxy.yaml templates/ops.yaml | awk -F: '{ s += $2 } END { print s }')" = 0
check test "$(grep -c '^ *Environment=' templates/proxy.yaml)" = 0
# O encaminhador: usuário dinâmico, credencial por LoadCredential, reinício sempre, endurecido, sem IMDS.
for line in 'DynamicUser=yes' 'LoadCredential=tinyproxy.conf:/etc/bb-proxy/upstream.conf' \
  'ExecStart=/usr/bin/tinyproxy -d -c %d/tinyproxy.conf' 'Restart=always' 'NoNewPrivileges=yes' 'ProtectSystem=strict' \
  'PrivateTmp=yes' 'CapabilityBoundingSet=' 'IPAddressDeny=link-local multicast 10.0.0.0/8 100.64.0.0/10 172.16.0.0/12 192.168.0.0/16' \
  'Requires=bb-srv-egress-guard.service' 'Before=docker.service' 'User=bb-proxy' 'LimitCORE=0' \
  'iptables -I OUTPUT 1 -m owner --uid-owner "$uid" -j "$FWD_CHAIN"' \
  'iptables -I DOCKER-USER 1 -i "$BRIDGE" -m comment --comment "$HOLD" -j DROP' \
  'ip6tables -I "$chain" 1 -i "$BRIDGE" -j DROP' 'result="fail no-upstream"' 'result="fail firewall-hold"'; do
  check grep -qF -- "$line" templates/proxy.yaml
done
# A trava temporária do guard é só a marcada (nunca apaga a regra sem marca do openbot-firewall).
check test "$(grep -c 'iptables -D DOCKER-USER -i "$BRIDGE" -j DROP' templates/proxy.yaml)" = 0
# O SSM é lido no boot e no ProxyReload, não a cada reinício do encaminhador (sem laço de GetParameter).
check test "$(grep -c 'Wants=bb-proxy-config.service' templates/proxy.yaml)" = 0
check grep -qF -- '--cli-connect-timeout 10 --cli-read-timeout 20' templates/proxy.yaml
check test "$(awk '/bb-proxy-config.service <</ {on = 1} on && /^ *UNIT$/ {exit} on' templates/proxy.yaml | grep -c 'RemainAfterExit=yes\|TimeoutStartSec=')" = 2
check grep -q "install -d -m 0700 -o root -g root \"\${UPSTREAM%/\*}\"" templates/proxy.yaml
# bb-srv-Install: o proxy entra depois do setup do docker/instances e antes de qualquer contêiner.
setup_line=$(grep -nF '"$I" setup' templates/ops.yaml | head -n 1 | cut -d: -f1)
proxy_line=$(grep -nF 'name bb-srv-ProxySetup' templates/ops.yaml | head -n 1 | cut -d: -f1)
create_line=$(grep -nF '"$I" create' templates/ops.yaml | head -n 1 | cut -d: -f1)
check test "${setup_line:-0}" -gt 0
check test "${proxy_line:-0}" -gt "${setup_line:-0}"
check test "${create_line:-0}" -gt "${proxy_line:-0}"
# O Install roda o setup sem a parte de reparo (--from-install) e confere o contêiner pelo verify (judge acima).
check grep -qF 'bash "$setup" --from-install' templates/ops.yaml
check grep -qF '"$P" verify || fail' templates/ops.yaml
check grep -qF 'if [ "${1:-}" != --from-install ] && [ -f /var/lib/bb-srv/installed ]' templates/proxy.yaml
# O contêiner não sobe no boot sem o firewall, antes do fim do Install nesta VM, nem depois de um vazamento.
check grep -qxF '            Requires=docker.service bb-srv-egress-guard.service' templates/sector-compute.yaml
check grep -qxF '            ConditionPathExists=/var/lib/bb-srv/installed' templates/sector-compute.yaml
check grep -qF 'ConditionPathExists=!/var/lib/bb-srv/egress-open' templates/proxy.yaml
# A saúde testa de dentro da rede do contêiner e para o contêiner num vazamento provado.
for reason in contained no-signal-rule direct-open dns-open direct-unknown container-dns; do
  check grep -qF "result=\"fail $reason\"" templates/proxy.yaml
done
check grep -qF 'body=$(in_net "$pid" curl' templates/proxy.yaml
# O SSM lê {{ ... }} como parâmetro do documento: nada disso nos scripts dos documentos.
check test "$(grep -c '{{' templates/proxy.yaml)" = 0
# O bootstrap: tinyproxy mascarado antes do apt (o pacote não sobe sozinho) e DNS do contêiner só no host.
mask_line=$(grep -n 'systemctl mask tinyproxy.service' templates/sector-compute.yaml | cut -d: -f1)
apt_line=$(grep -n 'ca-certificates tinyproxy dnsmasq-base$' templates/sector-compute.yaml | cut -d: -f1)
check test "${mask_line:-0}" -gt 0
check test "${apt_line:-0}" -gt "${mask_line:-0}"
check grep -q '"dns": \["172.30.0.1"\]' templates/sector-compute.yaml
# O stub do systemd-resolved em 172.30.0.1 resolvia qualquer nome pelo resolvedor da VPC: só o dnsmasq restrito.
check test "$(grep -c 'DNSStubListenerExtra=' templates/sector-compute.yaml)" = 0
check grep -q 'dns-unit "$("$P" mode)"' templates/proxy.yaml
# Alarme: só "ok BR" conta; horário comercial trata falta de dado como o alarme de saúde; tópico de alertas.
check grep -q "FilterPattern: '\"BB_PROXY_HEALTH ok BR\"'" templates/sector-compute.yaml
check test "$(grep -c 'TreatMissingData: !If \[IsAlwaysOn, breaching, notBreaching\]' templates/sector-compute.yaml)" = 2
check test "$(awk '/^  ProxyHealthAlarm:/ {on = 1} on && /^  [A-Za-z]+:$/ && !/ProxyHealthAlarm/ {on = 0} on' templates/sector-compute.yaml | grep -c 'bb-srv-base-AlertTopicArn\|Condition: UseEgressProxy')" = 2
check grep -q -- '- bb-srv-ProxySetup' templates/sector-compute.yaml
check grep -q -- '- bb-srv-ProxyReload' templates/sector-compute.yaml
# Cada template cabe no --template-body (51.200 bytes).
for template in templates/*.yaml; do check test "$(wc -c <"$template")" -lt 51200; done
if [ -z "$static_fail" ]; then
  ok_case "F7 templates: só o host lê a credencial, encaminhador endurecido, proxy antes do contêiner, alarme só com BR"
else
  bad "F7 templates do proxy de saída" "$static_fail"
fi

# F8: os filtros de métrica de saúde leem SÓ o grupo de saúde (escrito pelo host). O log do app, no grupo
# principal, tem texto que agentes e páginas influenciam: uma linha forjada ali não pode calar um alarme.
health_fail=''
check_health() { "$@" >/dev/null 2>&1 || health_fail="$health_fail [$*]"; }
for filter in bb-srv-health-ok bb-srv-proxy-health-ok-br; do
  check_health test "$(grep -B2 "FilterName: $filter" templates/sector-compute.yaml | grep -c 'LogGroupName: !Ref HealthLogGroup')" = 1
done
check_health test "$(grep -c 'LogGroupName: !Ref LogGroup$' templates/sector-compute.yaml)" = 0
check_health grep -q '"log_group_name": "/bb-srv/${Sector}/health", "log_stream_name": "{instance_id}/health"' templates/sector-compute.yaml
check_health grep -q "log-group:/bb-srv/\${Sector}/health:\*" templates/sector-compute.yaml
check_health grep -q 'DependsOn: \[AgentConfigParameter, EgressParameter, LogGroup, SessionLogGroup, HealthLogGroup\]' templates/sector-compute.yaml
if [ -z "$health_fail" ]; then
  ok_case "F8 os filtros de saúde leem só o grupo de logs da saúde (o log do app não pode forjar BB_HEALTH ok)"
else
  bad "F8 filtros de saúde no grupo errado" "$health_fail"
fi

printf '\n%s ok, %s falharam\n' "$passed" "$failed"
[ "$failed" = 0 ]
