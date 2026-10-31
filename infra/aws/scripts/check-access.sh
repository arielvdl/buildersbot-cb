#!/usr/bin/env bash
# Verifica, antes de qualquer comando na AWS, que:
#   1. nenhuma variável de ambiente troca as credenciais ou o perfil;
#   2. o perfil é `cb` e a conta é 358748433479 (região us-east-1);
#   3. o IP de saída deste computador está em config/allowed-egress-ips.txt.
# Para em qualquer falha. Os outros scripts carregam este arquivo e chamam bb_check_access.
# Só faz leituras: checkip.amazonaws.com e `sts get-caller-identity`.
#
# Uso: scripts/check-access.sh

BB_EXPECTED_ACCOUNT=358748433479
BB_EXPECTED_REGION=us-east-1
BB_EXPECTED_PROFILE=cb

bb_access_fail() {
  printf 'ERRO (acesso): %s\n' "$*" >&2
  return 1
}

bb_check_access() {
  local root file ip line allowed=0 account arn variable

  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  file=$root/config/allowed-egress-ips.txt

  # Credenciais em variáveis de ambiente teriam precedência sobre a configuração do perfil.
  for variable in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN; do
    [ -z "${!variable:-}" ] || { bb_access_fail "a variável $variable está definida. Remova-a: os scripts usam só o perfil $BB_EXPECTED_PROFILE."; return 1; }
  done
  if [ -n "${AWS_PROFILE:-}" ] && [ "$AWS_PROFILE" != "$BB_EXPECTED_PROFILE" ]; then
    bb_access_fail "AWS_PROFILE=$AWS_PROFILE. Use AWS_PROFILE=$BB_EXPECTED_PROFILE ou remova a variável."; return 1
  fi
  if [ -n "${AWS_DEFAULT_PROFILE:-}" ] && [ "$AWS_DEFAULT_PROFILE" != "$BB_EXPECTED_PROFILE" ]; then
    bb_access_fail "AWS_DEFAULT_PROFILE=$AWS_DEFAULT_PROFILE. Remova a variável."; return 1
  fi
  command -v aws >/dev/null || { bb_access_fail "o AWS CLI não está instalado."; return 1; }
  command -v curl >/dev/null || { bb_access_fail "curl não está instalado."; return 1; }
  aws configure list-profiles 2>/dev/null | grep -qx "$BB_EXPECTED_PROFILE" ||
    { bb_access_fail "o perfil $BB_EXPECTED_PROFILE não existe no AWS CLI."; return 1; }

  ip=$(curl -fsS -m 8 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]') ||
    { bb_access_fail "não consegui ler o IP de saída (checkip.amazonaws.com)."; return 1; }
  [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { bb_access_fail "resposta inesperada do checkip: $ip"; return 1; }
  [ -f "$file" ] || { bb_access_fail "falta $file."; return 1; }
  while read -r line _; do
    case $line in '' | '#'*) continue ;; esac
    if [ "$line" = "$ip" ]; then allowed=1; fi
  done <"$file"
  [ "$allowed" = 1 ] || { bb_access_fail "o IP de saída $ip não está em config/allowed-egress-ips.txt. Pare: a política da conta pode negar a chamada, ou a rede é outra."; return 1; }

  if ! read -r account arn < <(aws --profile "$BB_EXPECTED_PROFILE" --region "$BB_EXPECTED_REGION" sts get-caller-identity --query '[Account,Arn]' --output text 2>/dev/null); then
    bb_access_fail "sts get-caller-identity falhou com o perfil $BB_EXPECTED_PROFILE (credencial vencida, MFA ou rede)."; return 1
  fi
  [ "$account" = "$BB_EXPECTED_ACCOUNT" ] ||
    { bb_access_fail "o perfil $BB_EXPECTED_PROFILE aponta para a conta $account, não para $BB_EXPECTED_ACCOUNT."; return 1; }
  case $arn in
    *:user/*) printf 'AVISO: %s usa uma chave de longa duração. Prefira uma sessão com MFA (README, seção Acesso).\n' "$arn" >&2 ;;
  esac

  BB_CALLER_ARN=$arn
  BB_EGRESS_IP=$ip
  export BB_CALLER_ARN BB_EGRESS_IP
  printf 'acesso ok: perfil %s, conta %s, região %s, IP de saída %s\n' "$BB_EXPECTED_PROFILE" "$account" "$BB_EXPECTED_REGION" "$ip" >&2
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  bb_check_access
fi
