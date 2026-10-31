#!/usr/bin/env bash
# Verifica, antes de qualquer comando na AWS, que:
#   1. nenhuma variável de ambiente troca as credenciais, o perfil, o endpoint ou (com --writes) os
#      arquivos de configuração do AWS CLI;
#   2. o perfil é `cb` e a conta é 358748433479 (região us-east-1);
#   3. o IP de saída deste computador está em config/allowed-egress-ips.txt (arquivo local, fora do
#      git: copie config/allowed-egress-ips.example.txt). Sem o arquivo, para (falha fechada);
#   4. com --writes (todo script que altera a AWS: todos menos status.sh e validate.sh): a credencial
#      é a sessão de uma role de config/mfa-roles.txt (roles cuja trust exige MFA). Qualquer outra
#      (credencial de usuário IAM, AKIA ou sessão ASIA sem MFA comprovável, ou outra role) é recusada,
#      salvo com BB_SRV_ALLOW_LONG_TERM_KEY=1 explícito; a do root, sempre.
# Para em qualquer falha. Os outros scripts carregam este arquivo e chamam bb_check_access.
# Só faz leituras: checkip.amazonaws.com e `sts get-caller-identity`. Nenhuma credencial é lida.
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

# A role de um ARN assumed-role está em config/mfa-roles.txt?
bb_mfa_role() { # <arn> <arquivo>
  local role line
  role=${1#*:assumed-role/}
  role=${role%%/*}
  [ -f "$2" ] || return 1
  while read -r line _; do
    case $line in '' | '#'*) continue ;; esac
    [ "$line" != "$role" ] || return 0
  done <"$2"
  return 1
}

bb_check_access() { # [--writes]
  local root file ip line allowed=0 account arn variable writes=0 kind reason

  case ${1:-} in
    '') ;;
    --writes) writes=1 ;;
    *) bb_access_fail "uso: bb_check_access [--writes]"; return 1 ;;
  esac
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  file=$root/config/allowed-egress-ips.txt
  # Só tests/negative.sh: o exemplo versionado tem só endereços de documentação (203.0.113.0/24), que
  # nenhum checkip real devolve. Fora dos testes, apontar para ele só faz a checagem recusar.
  [ "${BB_SRV_TEST_EGRESS_EXAMPLE:-0}" != 1 ] || file=$root/config/allowed-egress-ips.example.txt
  if [ ! -f "$file" ]; then
    bb_access_fail "falta config/allowed-egress-ips.txt (arquivo local, fora do git, com os IPs de saída permitidos). Crie a partir do exemplo: cp config/allowed-egress-ips.example.txt config/allowed-egress-ips.txt, troque os endereços de exemplo pelo IP de saída desta rede (curl -fsS https://checkip.amazonaws.com) e rode de novo."
    return 1
  fi

  # Credenciais em variáveis de ambiente teriam precedência sobre a configuração do perfil, e um
  # endpoint trocado responderia no lugar da AWS (inclusive o sts get-caller-identity abaixo).
  for variable in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN \
    $(compgen -v | grep -E '^AWS_ENDPOINT_URL' || true); do
    [ -z "${!variable:-}" ] || { bb_access_fail "a variável $variable está definida. Remova-a: os scripts usam só o perfil $BB_EXPECTED_PROFILE."; return 1; }
  done
  # Outros arquivos de configuração trocam o que o perfil cb é (outra role, outra chave, credential_process).
  for variable in AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE; do
    [ -n "${!variable:-}" ] || continue
    if [ "$writes" = 1 ]; then
      bb_access_fail "a variável $variable está definida e este script altera a AWS. Remova-a: o perfil $BB_EXPECTED_PROFILE vem de ~/.aws."; return 1
    fi
    printf 'AVISO: %s está definida e troca a configuração do perfil %s. Os scripts que alteram a AWS a recusam.\n' "$variable" "$BB_EXPECTED_PROFILE" >&2
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
  while read -r line _; do
    case $line in '' | '#'*) continue ;; esac
    if [ "$line" = "$ip" ]; then allowed=1; fi
  done <"$file"
  [ "$allowed" = 1 ] || { bb_access_fail "o IP de saída $ip não está em config/${file##*/}. Pare: a política da conta pode negar a chamada, ou a rede é outra."; return 1; }

  if ! read -r account arn < <(aws --profile "$BB_EXPECTED_PROFILE" --region "$BB_EXPECTED_REGION" sts get-caller-identity --query '[Account,Arn]' --output text 2>/dev/null); then
    bb_access_fail "sts get-caller-identity falhou com o perfil $BB_EXPECTED_PROFILE (credencial vencida, MFA ou rede)."; return 1
  fi
  [ "$account" = "$BB_EXPECTED_ACCOUNT" ] ||
    { bb_access_fail "o perfil $BB_EXPECTED_PROFILE aponta para a conta $account, não para $BB_EXPECTED_ACCOUNT."; return 1; }

  # Temporária com MFA só a sessão de uma role de config/mfa-roles.txt (a trust dela exige MFA). Uma
  # credencial do usuário IAM pode ser a chave AKIA ou uma sessão ASIA de get-session-token, que
  # também sai sem MFA: nas duas o MFA não é comprovável daqui. Outra role pode não exigir MFA.
  case $arn in
    arn:aws:iam::*:root) kind=root ;;
    arn:aws:sts::*:assumed-role/*)
      if bb_mfa_role "$arn" "$root/config/mfa-roles.txt"; then kind=temporary; else kind=unlisted-role; fi
      ;;
    *) kind=long-term ;;
  esac
  if [ "$kind" = root ]; then
    bb_access_fail "$arn é a conta root. Estes scripts nunca rodam com ela."; return 1
  fi
  if [ "$kind" != temporary ]; then
    if [ "$kind" = unlisted-role ]; then
      reason="é a sessão de uma role fora de config/mfa-roles.txt (roles cuja trust exige MFA)"
    else
      reason="usa uma chave de longa duração ou uma sessão de usuário IAM (MFA não comprovável)"
    fi
    if [ "$writes" = 0 ]; then
      printf 'AVISO: %s %s. Os scripts que alteram a AWS a recusam: use uma sessão com MFA (README, seção 3).\n' "$arn" "$reason" >&2
    elif [ "${BB_SRV_ALLOW_LONG_TERM_KEY:-0}" = 1 ]; then
      printf 'AVISO: %s %s; aceita só porque BB_SRV_ALLOW_LONG_TERM_KEY=1.\n' "$arn" "$reason" >&2
    else
      # Sob set -e, um retorno 1 do bb_access_fail sairia antes da ajuda.
      bb_access_fail "recusado: $arn $reason, e este script altera a AWS." || true
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
