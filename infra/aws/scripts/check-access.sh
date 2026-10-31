#!/usr/bin/env bash
# Verifica, antes de qualquer comando na AWS, que:
#   1. nenhuma variável de ambiente troca as credenciais ou o perfil;
#   2. o perfil é `cb` e a conta é 358748433479 (região us-east-1);
#   3. o IP de saída deste computador está em config/allowed-egress-ips.txt;
#   4. com --writes (todo script que altera a AWS: todos menos status.sh e validate.sh): a credencial
#      é TEMPORÁRIA (role assumida com MFA, ou sessão do usuário com MFA). Uma chave de longa duração
#      de usuário IAM é recusada, salvo com BB_SRV_ALLOW_LONG_TERM_KEY=1 explícito; a do root, sempre.
# Para em qualquer falha. Os outros scripts carregam este arquivo e chamam bb_check_access.
# Só faz leituras: checkip.amazonaws.com, `sts get-caller-identity` e, para um ARN de usuário, o
# prefixo do id da chave em uso (`aws configure export-credentials`, lido só pelo jq; nada é exibido).
#
# Uso: scripts/check-access.sh [--writes]

BB_EXPECTED_ACCOUNT=358748433479
BB_EXPECTED_REGION=us-east-1
BB_EXPECTED_PROFILE=cb

bb_access_fail() {
  printf 'ERRO (acesso): %s\n' "$*" >&2
  return 1
}

# Como abrir a sessão temporária com MFA que os scripts de escrita exigem (README, seção 3).
bb_mfa_help() {
  cat >&2 <<EOF
Sessão temporária com MFA (README, seção 3, "Acesso"):
  1. Em ~/.aws/credentials, renomeie o perfil [cb] (a chave do usuário) para [cb-chave].
  2. Em ~/.aws/config, aponte o perfil cb para a role de administração com MFA que já existe na conta:
       [profile cb]
       source_profile = cb-chave
       role_arn = arn:aws:iam::$BB_EXPECTED_ACCOUNT:role/culturabuilder-admin
       mfa_serial = arn:aws:iam::$BB_EXPECTED_ACCOUNT:mfa/<dispositivo>   (aws iam list-mfa-devices)
       duration_seconds = 14400
       region = $BB_EXPECTED_REGION
  3. Rode o script de novo: o AWS CLI pede o código MFA uma vez e guarda a sessão (até 4 h).
Só se não houver outro jeito, com a chave de longa duração e conscientemente:
  BB_SRV_ALLOW_LONG_TERM_KEY=1 <script> ...
EOF
}

# Tipo da credencial de um ARN de usuário IAM: uma sessão do usuário com MFA (sts get-session-token)
# também aparece como :user/. O id da chave diz: ASIA = temporária, AKIA = longa duração.
bb_user_key_kind() {
  local prefix=''
  # O segredo só passa pelo pipe até o jq, que devolve os 4 primeiros caracteres do id da chave.
  prefix=$(aws configure export-credentials --profile "$BB_EXPECTED_PROFILE" --format process 2>/dev/null |
    jq -r '(.AccessKeyId // "") | .[0:4]' 2>/dev/null) || prefix=''
  case $prefix in
    ASIA) echo temporary ;;
    *) echo long-term ;;
  esac
}

bb_check_access() { # [--writes]
  local root file ip line allowed=0 account arn variable writes=0 kind

  case ${1:-} in
    '') ;;
    --writes) writes=1 ;;
    *) bb_access_fail "uso: bb_check_access [--writes]"; return 1 ;;
  esac
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
    arn:aws:iam::*:root) kind=root ;;
    arn:aws:sts::*:assumed-role/* | arn:aws:sts::*:federated-user/*) kind=temporary ;;
    arn:aws:iam::*:user/*) kind=$(bb_user_key_kind) ;;
    *) kind=long-term ;;
  esac
  if [ "$kind" = root ]; then
    bb_access_fail "$arn é a conta root. Estes scripts nunca rodam com ela."; return 1
  fi
  if [ "$kind" = long-term ]; then
    if [ "$writes" = 0 ]; then
      printf 'AVISO: %s usa uma chave de longa duração. Os scripts que alteram a AWS a recusam: use uma sessão com MFA (README, seção 3).\n' "$arn" >&2
    elif [ "${BB_SRV_ALLOW_LONG_TERM_KEY:-0}" = 1 ]; then
      printf 'AVISO: %s usa uma chave de longa duração, aceita só porque BB_SRV_ALLOW_LONG_TERM_KEY=1.\n' "$arn" >&2
    else
      # Sob set -e, um retorno 1 do bb_access_fail sairia antes da ajuda.
      bb_access_fail "recusado: $arn usa uma chave de longa duração e este script altera a AWS." || true
      bb_mfa_help
      return 1
    fi
  fi

  BB_CALLER_ARN=$arn
  BB_EGRESS_IP=$ip
  export BB_CALLER_ARN BB_EGRESS_IP
  printf 'acesso ok: perfil %s, conta %s, região %s, IP de saída %s, credencial %s\n' \
    "$BB_EXPECTED_PROFILE" "$account" "$BB_EXPECTED_REGION" "$ip" "$kind" >&2
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  bb_check_access "$@"
fi
