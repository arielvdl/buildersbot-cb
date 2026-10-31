#!/usr/bin/env bash
# Cria ou atualiza as stacks compartilhadas bb-srv-base (rede, ECR, buckets, alertas, IAM, zona DNS,
# orçamento) e bb-srv-ops (documentos SSM e backups DLM). Mostra cada change set e pede confirmação.
# No fim, mostra os 4 registros NS que o dono cria no Cloudflare (a única ação de DNS).
#
# Uso: scripts/deploy-base.sh --alert-email <e-mail> [--zone bb-aws.culturabuilder.com]
#                             [--project-budget-usd 150] [--yes]
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

alert_email=''
zone=bb-aws.culturabuilder.com
budget=150
while [ "$#" -gt 0 ]; do
  case $1 in
    --alert-email) alert_email=${2:-} ; shift 2 ;;
    --zone) zone=${2:-} ; shift 2 ;;
    --project-budget-usd) budget=${2:-} ; shift 2 ;;
    --yes) BB_SRV_YES=1 ; shift ;;
    -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
[ -n "$alert_email" ] || die "informe --alert-email (o e-mail que recebe os alertas; o dono confirma a inscrição)."
valid_email "$alert_email"
[[ $budget =~ ^[0-9]+$ ]] || die "--project-budget-usd precisa ser um número inteiro."

bb_check_access

deploy_stack bb-srv-base "$BB_ROOT/templates/base.yaml" shared \
  "ParameterKey=AlertEmail,ParameterValue=$alert_email" \
  "ParameterKey=DelegatedZoneName,ParameterValue=$zone" \
  "ParameterKey=ProjectBudgetUsd,ParameterValue=$budget"

deploy_stack bb-srv-ops "$BB_ROOT/templates/ops.yaml" shared

# Verificações do passo 2 do roteiro (DESIGN 12): SG sem entrada, nenhum NAT na VPC nova.
vpc=$(stack_output bb-srv-base VpcId)
sg=$(aws_cb ec2 describe-security-groups --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=bb-srv-sector" \
  --query 'SecurityGroups[0].IpPermissions | length(@)' --output text)
nat=$(aws_cb ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$vpc" --query 'length(NatGateways)' --output text)
say "verificação: regras de entrada do SG bb-srv-sector = $sg (esperado 0); NAT gateways na VPC $vpc = $nat (esperado 0)."
[ "$sg" = 0 ] && [ "$nat" = 0 ] || die "a verificação falhou."

zone_id=$(stack_output bb-srv-base HostedZoneId)
servers=$(stack_output bb-srv-base HostedZoneNameServers)
label=${zone%%.*}
cat <<EOF

== Ação do dono no Cloudflare (uma vez, ~5 min)
Zona culturabuilder.com -> DNS -> Records -> Add record, 4 vezes:
  Tipo NS | Nome $label | TTL Auto | Nameserver: um de cada vez:
$(printf '%s\n' "$servers" | tr ',' '\n' | sed 's/^/    /')
Conferir depois: dig +short NS $zone   (mostra os 4 acima)
Zona Route 53: $zone_id

== Também do dono
- Confirmar o e-mail de inscrição do tópico bb-srv-alerts que chega em $alert_email.
- Billing -> Cost allocation tags: ativar Project, Sector e CostCenter (os budgets dependem disso).
EOF
