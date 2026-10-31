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

printf '\n%s ok, %s falharam\n' "$passed" "$failed"
[ "$failed" = 0 ]
