#!/usr/bin/env bash
# Cria ou atualiza a stack bb-srv-signal: o Signal (WSS) e o TURN próprios do Builders Bot, a partir
# de remote/ do fork no commit do Worker publicado (DESIGN 2.7). Sem eles nenhum setor conecta.
#
#   1. confere a delegação DNS (dig) da zona da stack bb-srv-base;
#   2. cria os 4 segredos em /bb-srv/signal/* (SSM SecureString) se ainda não existem. Os valores
#      vêm do openssl pela entrada padrão do AWS CLI: nunca aparecem na tela, em argumento ou em disco;
#   3. envia o código do commit para o bucket de build;
#   4. cria a stack. As portas de entrada só abrem com --approve-ingress (exceção que o dono aprova).
#
# Uso: scripts/deploy-signal.sh --commit <sha do Worker publicado> --acme-email <e-mail>
#                               [--approve-ingress] [--instance-type t4g.small] [--skip-dns-check] [--yes]
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

commit=''
acme_email=''
ingress=false
instance_type=t4g.small
dns_check=1
while [ "$#" -gt 0 ]; do
  case $1 in
    --commit) commit=${2:-} ; shift 2 ;;
    --acme-email) acme_email=${2:-} ; shift 2 ;;
    --approve-ingress) ingress=true ; shift ;;
    --instance-type) instance_type=${2:-} ; shift 2 ;;
    --skip-dns-check) dns_check=0 ; shift ;;
    --yes) BB_SRV_YES=1 ; shift ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
[ -n "$commit" ] || die "informe --commit (o mesmo commit do Worker de contas publicado)."
[ -n "$acme_email" ] || die "informe --acme-email."
valid_email "$acme_email"

bb_check_access
require_stack bb-srv-base "Rode scripts/deploy-base.sh antes."

zone=$(stack_output bb-srv-base HostedZoneName)
zone_id=$(stack_output bb-srv-base HostedZoneId)
if [ "$dns_check" = 1 ]; then
  command -v dig >/dev/null || die "dig não está instalado (ou use --skip-dns-check)."
  expected=$(aws_cb route53 get-hosted-zone --id "$zone_id" --query 'DelegationSet.NameServers' --output text | tr '\t' '\n' | sort)
  actual=$(dig +short NS "$zone" @1.1.1.1 | sed 's/\.$//' | sort)
  [ -n "$actual" ] && [ "$actual" = "$expected" ] ||
    die "a zona $zone ainda não está delegada ao Route 53 (dig NS mostra: ${actual:-nada}). Sem isso o certificado não sai. Faça a ação do dono no Cloudflare (README)."
  say "   delegação DNS de $zone ok."
fi

# Segredos novos (32 bytes em hexadecimal). Um valor existente nunca é trocado aqui.
for name in remote-session-secret remote-auth-webhook-secret remote-metrics-token turn-shared-secret; do
  if aws_cb ssm describe-parameters --parameter-filters "Key=Name,Values=/bb-srv/signal/$name" --query 'length(Parameters)' --output text | grep -qx 1; then
    say "   /bb-srv/signal/$name já existe."
    continue
  fi
  openssl rand -hex 32 | tr -d '\n' | aws_cb ssm put-parameter --name "/bb-srv/signal/$name" --type SecureString \
    --value file:///dev/stdin --description "Builders Bot Signal: $name" \
    --tags "Key=Project,Value=$BB_PROJECT" "Key=Sector,Value=shared" "Key=CostCenter,Value=shared" "Key=Owner,Value=$BB_OWNER" >/dev/null
  say "   /bb-srv/signal/$name criado (valor não exibido)."
done

sha=$(upload_source "$commit")
ami=$(ubuntu_ami arm64)
[[ $ami =~ ^ami-[0-9a-f]+$ ]] || die "não consegui resolver a AMI do Ubuntu 24.04 arm64."
say "   commit $sha, AMI $ami, portas de entrada abertas: $ingress"
if [ "$ingress" = true ]; then
  confirm "Abrir TCP 443, TCP/UDP 3478, TCP 5349 e UDP 49152-65535 da internet na VM do Signal (exceção aprovada pelo dono)? Digite 'aprovado':" aprovado
fi
check_vcpu_quota 2

deploy_stack bb-srv-signal "$BB_ROOT/templates/signal.yaml" shared \
  "ParameterKey=AmiId,ParameterValue=$ami" \
  "ParameterKey=InstanceType,ParameterValue=$instance_type" \
  "ParameterKey=SourceCommit,ParameterValue=$sha" \
  "ParameterKey=IngressApproved,ParameterValue=$ingress" \
  "ParameterKey=AcmeEmail,ParameterValue=$acme_email"

cat <<EOF

== Próximos passos
1. Esperar o primeiro boot (build das imagens e certificado: ~15 a 25 min) e conferir:
     curl -fsS https://signal.$zone/health/turn     (precisa de --approve-ingress)
     scripts/status.sh
2. Só depois, no Worker de contas (apps/auth-api, com wrangler login, pelo dev com o OK do dono):
     REMOTE_SIGNAL_URL        = $(stack_output bb-srv-signal SignalUrl)
     REMOTE_AUTH_WEBHOOK_URL  = $(stack_output bb-srv-signal AuthWebhookUrl)
     REMOTE_AUTH_WEBHOOK_SECRET (segredo do Worker), sem exibir o valor:
       aws --profile cb --region us-east-1 ssm get-parameter --with-decryption \\
         --name /bb-srv/signal/remote-auth-webhook-secret --query Parameter.Value --output text \\
         | bunx wrangler secret put REMOTE_AUTH_WEBHOOK_SECRET
EOF
