#!/usr/bin/env bash
# Cria ou atualiza as stacks compartilhadas, nesta ordem:
#   1. bb-srv-dns  (a zona Route 53 delegada; fica de pé quando as outras são apagadas ou refeitas,
#                   então os 4 NS do Cloudflare não mudam);
#   2. bb-srv-base (rede, ECR, buckets, alertas, IAM, orçamento do projeto);
#   3. bb-srv-ops  (documentos SSM, inclusive o bb-srv-ProxyReload e o bb-srv-ProxyChecks do proxy de
#                   saída, e backups DLM);
#   4. bb-srv-proxy (o documento SSM bb-srv-ProxySetup do proxy de saída residencial, que o
#                    bb-srv-Install roda; README, seção 16).
#   Uma bb-srv-proxy do template antigo, ainda dona do documento bb-srv-ProxyReload, vai antes da
#   bb-srv-ops (3 e 4 trocados): ela solta o nome do documento, que a ops passa a criar.
# Mostra cada change set e pede confirmação. No fim, mostra os 4 registros NS que o dono cria no
# Cloudflare (a única ação de DNS).
#
# Uso: scripts/deploy-base.sh [--alert-email <e-mail>] [--zone bb-aws.culturabuilder.com]
#                             [--project-budget-usd N] [--yes]
#   Criação: --alert-email é obrigatório (o budget do projeto começa em 150; o add-sector.sh ajusta).
#   Atualização: o que não vier fica como está (UsePreviousValue), inclusive o budget e o e-mail.
#   Trocar a zona numa atualização substitui a zona: o change set é recusado (README, seção 11).
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

alert_email=''
zone=''
budget=''
while [ "$#" -gt 0 ]; do
  case $1 in
    --alert-email) alert_email=${2:-} ; shift 2 ;;
    --zone) zone=${2:-} ; shift 2 ;;
    --project-budget-usd) budget=${2:-} ; shift 2 ;;
    --yes) BB_SRV_YES=1 ; shift ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
[ -z "$alert_email" ] || valid_email "$alert_email"
[ -z "$budget" ] || { [[ $budget =~ ^[0-9]+$ ]] && [ "$budget" -ge 10 ]; } || die "--project-budget-usd precisa ser um inteiro de 10 ou mais."
[ -z "$zone" ] || [[ $zone =~ ^[a-z0-9][a-z0-9.-]{1,200}[a-z0-9]$ ]] || die "--zone inválida: $zone"

bb_check_access --writes

# Parâmetro dado vira valor; não dado, numa atualização, fica como está.
param() { # <chave> <valor ou vazio> <tipo da operação: CREATE|UPDATE>
  if [ -n "$2" ]; then
    printf 'ParameterKey=%s,ParameterValue=%s\n' "$1" "$2"
  elif [ "$3" = UPDATE ]; then
    printf 'ParameterKey=%s,UsePreviousValue=true\n' "$1"
  fi
}
operation() { case $(stack_status "$1") in NONE | REVIEW_IN_PROGRESS) echo CREATE ;; *) echo UPDATE ;; esac; }

# Antes de qualquer escrita: na criação da base, sobras de uma base anterior (buckets e ECR de nome
# fixo) fariam a criação falhar com AlreadyExists. Pare antes, com o que fazer.
base_op=$(operation bb-srv-base)
if [ "$base_op" = CREATE ]; then
  [ -n "$alert_email" ] || die "informe --alert-email (o e-mail que recebe os alertas; o dono confirma a inscrição)."
  leftovers=''
  for bucket in "bb-srv-logs-$BB_EXPECTED_ACCOUNT" "bb-srv-build-$BB_EXPECTED_ACCOUNT"; do
    if aws_cb s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then leftovers="$leftovers s3://$bucket"; fi
  done
  if aws_cb ecr describe-repositories --repository-names "$BB_REPO_NAME" >/dev/null 2>&1; then leftovers="$leftovers ecr:$BB_REPO_NAME"; fi
  [ -z "$leftovers" ] || die "sobras de uma bb-srv-base anterior:$leftovers. Elas ficam de propósito (dados: relatórios, logs, imagens).
Vazias e dispensáveis: apague-as à mão (bucket com versionamento: apague também as versões; ECR: só sem imagens, ecr delete-repository-policy e depois ecr delete-repository) e rode de novo.
Com dados que devem ficar: traga-as para a stack com um change set IMPORT (README, seção 11, 'Sobras da base') antes de criar o resto."
fi

# O bb-srv-ProxyReload passou da bb-srv-proxy para a bb-srv-ops (os 51.200 bytes do --template-body do proxy.yaml).
# Uma bb-srv-proxy do template antigo ainda é dona dele, e a ops antes dela falharia pelo nome de documento repetido
# (rollback limpo, mas o deploy trava): então a proxy vai primeiro e solta o nome. Até a ops terminar, o
# bb-srv-ProxySetup novo não acha o bb-srv-ProxyChecks e para sem mexer no host. Lido antes de qualquer escrita.
proxy_first=0
if [ "$(stack_status bb-srv-proxy)" != NONE ]; then
  reload_owner=$(aws_cb cloudformation describe-stack-resources --stack-name bb-srv-proxy \
    --query "StackResources[?LogicalResourceId=='ProxyReloadDocument'].ResourceStatus | [0]" --output text) ||
    die "não consegui ler os recursos da stack bb-srv-proxy (ela ainda é dona do bb-srv-ProxyReload?). Nada foi alterado; rode de novo."
  case $reload_owner in None | '' | DELETE_COMPLETE) ;; *) proxy_first=1 ;; esac
fi

# 1. A zona, numa stack própria: um rollback ou uma recriação da base não troca os NS já delegados.
dns_params=()
line=$(param DelegatedZoneName "$zone" "$(operation bb-srv-dns)")
[ -z "$line" ] || dns_params+=("$line")
deploy_stack bb-srv-dns "$BB_ROOT/templates/dns.yaml" shared ${dns_params[@]+"${dns_params[@]}"}

# 2. A base.
base_params=()
for line in "$(param AlertEmail "$alert_email" "$base_op")" "$(param ProjectBudgetUsd "$budget" "$base_op")"; do
  [ -z "$line" ] || base_params+=("$line")
done
if [ "$base_op" = UPDATE ]; then
  # Os outros parâmetros também ficam como estão (um padrão novo do template nunca troca a rede).
  for key in VpcCidr SubnetACidr SubnetBCidr ImageKeepCount; do base_params+=("ParameterKey=$key,UsePreviousValue=true"); done
fi
deploy_stack bb-srv-base "$BB_ROOT/templates/base.yaml" shared ${base_params[@]+"${base_params[@]}"}

# 3. Documentos SSM e backups. 4. O proxy de saída: o documento que instala o encaminhador e o firewall de falha
# fechada nos setores. Com a bb-srv-proxy antiga (dona do bb-srv-ProxyReload), 4 antes de 3.
if [ "$proxy_first" = 1 ]; then
  say "== a bb-srv-proxy ainda tem o bb-srv-ProxyReload (template antigo): ela vai antes da bb-srv-ops, que passa a criá-lo."
  deploy_stack bb-srv-proxy "$BB_ROOT/templates/proxy.yaml" shared
  deploy_stack bb-srv-ops "$BB_ROOT/templates/ops.yaml" shared
else
  deploy_stack bb-srv-ops "$BB_ROOT/templates/ops.yaml" shared
  deploy_stack bb-srv-proxy "$BB_ROOT/templates/proxy.yaml" shared
fi

# Verificações do passo 2 do roteiro (DESIGN 12): SG sem entrada, nenhum NAT na VPC nova.
vpc=$(stack_output bb-srv-base VpcId)
sg=$(aws_cb ec2 describe-security-groups --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=bb-srv-sector" \
  --query 'SecurityGroups[0].IpPermissions | length(@)' --output text)
nat=$(aws_cb ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$vpc" --query 'length(NatGateways)' --output text)
say "verificação: regras de entrada do SG bb-srv-sector = $sg (esperado 0); NAT gateways na VPC $vpc = $nat (esperado 0)."
[ "$sg" = 0 ] && [ "$nat" = 0 ] || die "a verificação falhou."

zone=$(stack_output bb-srv-dns HostedZoneName)
zone_id=$(stack_output bb-srv-dns HostedZoneId)
servers=$(stack_output bb-srv-dns HostedZoneNameServers)
label=${zone%%.*}
cat <<EOF

== Ação do dono no Cloudflare (uma vez, ~5 min; a zona não muda em rollback da base)
Zona culturabuilder.com -> DNS -> Records -> Add record, 4 vezes:
  Tipo NS | Nome $label | TTL Auto | Nameserver: um de cada vez:
$(printf '%s\n' "$servers" | tr ',' '\n' | sed 's/^/    /')
Conferir depois: dig +short NS $zone   (mostra os 4 acima)
Zona Route 53: $zone_id

== Também do dono
- Confirmar o e-mail de inscrição do tópico bb-srv-alerts (primeira criação).
- Billing -> Cost allocation tags: ativar Project, Sector e CostCenter (os budgets dependem disso).
EOF
