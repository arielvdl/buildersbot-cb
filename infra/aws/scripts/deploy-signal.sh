#!/usr/bin/env bash
# Cria ou atualiza a stack bb-srv-signal: o Signal (WSS) e o TURN próprios do Builders Bot, a partir
# de remote/ do fork no commit do Worker publicado (DESIGN 2.7). Sem eles nenhum setor conecta.
#
# CRIAÇÃO (a stack não existe):
#   1. confere a delegação DNS (dig) da zona;
#   2. cria os 4 segredos em /bb-srv/signal/* (SSM SecureString) se ainda não existem. Os valores
#      vêm do openssl pela entrada padrão do AWS CLI: nunca aparecem na tela, em argumento ou em disco;
#   3. envia o código do commit para o bucket de build (com o sha256, que a VM confere);
#   4. resolve a AMI do Ubuntu uma vez, confere as cotas de vCPU e de Elastic IP e cria a stack.
# ATUALIZAÇÃO (a stack existe): só abre ou fecha as portas (--approve-ingress) e, se pedido, troca o
#   tamanho, SOBRE O TEMPLATE JÁ IMPLANTADO (--use-previous-template): o templates/signal.yaml local não
#   entra, e todos os outros parâmetros ficam como estão (UsePreviousValue). AMI, commit, hash do código
#   e e-mail ACME mexem no ImageId ou no user data, que só se trocam recriando a VM (README, seção 11);
#   uma mudança no signal.yaml do repositório também só chega à VM recriando a stack. Por isso a
#   atualização não resolve AMI, não confere cota nem DNS e só mexe nas regras de entrada (e no tamanho,
#   se pedido): fechar as portas sempre funciona.
#
# As portas de entrada só abrem com --approve-ingress (exceção que o dono aprova). Toda execução SEM
# --approve-ingress deixa as portas FECHADAS.
#
# Uso (criação):    scripts/deploy-signal.sh --commit <sha do Worker publicado> --acme-email <e-mail>
#                                            [--instance-type t4g.small] [--skip-dns-check] [--yes]
# Uso (atualização): scripts/deploy-signal.sh [--approve-ingress] [--instance-type t4g.medium] [--yes]
#                   (--commit e --acme-email, se vierem, têm de ser os da criação)
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

commit=''
acme_email=''
ingress=false
instance_type=''
dns_check=1
while [ "$#" -gt 0 ]; do
  case $1 in
    --commit) commit=${2:-} ; shift 2 ;;
    --acme-email) acme_email=${2:-} ; shift 2 ;;
    --approve-ingress) ingress=true ; shift ;;
    --instance-type) instance_type=${2:-} ; shift 2 ;;
    --skip-dns-check) dns_check=0 ; shift ;;
    --yes) BB_SRV_YES=1 ; shift ;;
    -h | --help) sed -n '2,23p' "$0"; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
[ -z "$acme_email" ] || valid_email "$acme_email"
case $instance_type in '' | t4g.small | t4g.medium) ;; *) die "--instance-type precisa ser t4g.small ou t4g.medium." ;; esac

bb_check_access --writes
require_stack bb-srv-dns "Rode scripts/deploy-base.sh antes."
require_stack bb-srv-base "Rode scripts/deploy-base.sh antes."
zone=$(stack_output bb-srv-dns HostedZoneName)
zone_id=$(stack_output bb-srv-dns HostedZoneId)
status=$(stack_status bb-srv-signal)
secrets="remote-session-secret remote-auth-webhook-secret remote-metrics-token turn-shared-secret"
secret_exists() { aws_cb ssm describe-parameters --parameter-filters "Key=Name,Values=/bb-srv/signal/$1" --query 'length(Parameters)' --output text | grep -qx 1; }

if [ "$status" = NONE ] || [ "$status" = REVIEW_IN_PROGRESS ]; then
  [ -n "$commit" ] || die "informe --commit (o mesmo commit do Worker de contas publicado)."
  [ -n "$acme_email" ] || die "informe --acme-email."
  instance_type=${instance_type:-t4g.small}
  if [ "$dns_check" = 1 ]; then
    command -v dig >/dev/null || die "dig não está instalado (ou use --skip-dns-check)."
    expected=$(aws_cb route53 get-hosted-zone --id "$zone_id" --query 'DelegationSet.NameServers' --output text | tr '\t' '\n' | sort)
    actual=$(dig +short NS "$zone" @1.1.1.1 | sed 's/\.$//' | sort)
    [ -n "$actual" ] && [ "$actual" = "$expected" ] ||
      die "a zona $zone ainda não está delegada ao Route 53 (dig NS mostra: ${actual:-nada}). Sem isso o certificado não sai. Faça a ação do dono no Cloudflare (README)."
    say "   delegação DNS de $zone ok."
  fi

  # Segredos novos (32 bytes em hexadecimal). Um valor existente nunca é trocado aqui.
  for name in $secrets; do
    if secret_exists "$name"; then
      say "   /bb-srv/signal/$name já existe."
      continue
    fi
    openssl rand -hex 32 | tr -d '\n' | aws_cb ssm put-parameter --name "/bb-srv/signal/$name" --type SecureString \
      --value file:///dev/stdin --description "Builders Bot Signal: $name" \
      --tags "Key=Project,Value=$BB_PROJECT" "Key=Sector,Value=shared" "Key=CostCenter,Value=shared" "Key=Owner,Value=$BB_OWNER" >/dev/null
    say "   /bb-srv/signal/$name criado (valor não exibido)."
  done

  source=$(upload_source "$commit") || exit 1
  read -r sha source_hash <<<"$source"
  ami=$(ubuntu_ami arm64)
  [[ $ami =~ ^ami-[0-9a-f]+$ ]] || die "não consegui resolver a AMI do Ubuntu 24.04 arm64."
  say "   criação: commit $sha, AMI $ami (fixada até recriar a VM), portas de entrada abertas: $ingress"
  check_vcpu_quota 2
  check_eip_quota 1
  params=("ParameterKey=AmiId,ParameterValue=$ami"
    "ParameterKey=InstanceType,ParameterValue=$instance_type"
    "ParameterKey=SourceCommit,ParameterValue=$sha"
    "ParameterKey=SourceSha256,ParameterValue=$source_hash"
    "ParameterKey=IngressApproved,ParameterValue=$ingress"
    "ParameterKey=AcmeEmail,ParameterValue=$acme_email")
else
  sha=$(stack_parameter bb-srv-signal SourceCommit)
  if [ -n "$commit" ]; then
    wanted=$(git -C "$BB_FORK" rev-parse --verify "$commit^{commit}" 2>/dev/null) || die "commit desconhecido no fork $BB_FORK: $commit"
    [ "$wanted" = "$sha" ] ||
      die "a VM do Signal roda o commit $sha. Trocar o commit exige recriar a VM (o user data só roda no primeiro boot): README, seção 11 (delete-stack bb-srv-signal e deploy-signal.sh de novo)."
  fi
  previous_email=$(stack_parameter bb-srv-signal AcmeEmail)
  [ -z "$acme_email" ] || [ "$acme_email" = "$previous_email" ] ||
    die "a VM do Signal usa o e-mail ACME $previous_email. Trocar exige recriar a VM (README, seção 11)."
  for name in $secrets; do
    secret_exists "$name" || warn "/bb-srv/signal/$name não existe: a VM do Signal não sobe no próximo restart. Recrie a stack (README, seção 11)."
  done
  say "   atualização sobre o template já implantado: commit $sha, AMI e user data mantidos; portas de entrada abertas: $ingress"
  changes=("IngressApproved=$ingress")
  if [ -n "$instance_type" ]; then
    warn "trocar o tamanho desliga e religa a VM do Signal (conexões novas param por alguns minutos)."
    changes+=("InstanceType=$instance_type")
  fi
fi

if [ "$ingress" = true ]; then
  confirm "Abrir TCP 443, TCP/UDP 3478, TCP 5349 e UDP 49152-65535 da internet na VM do Signal (exceção aprovada pelo dono)? Digite 'aprovado':" aprovado
fi

if [ "$status" = NONE ] || [ "$status" = REVIEW_IN_PROGRESS ]; then
  deploy_stack bb-srv-signal "$BB_ROOT/templates/signal.yaml" shared "${params[@]}"
else
  # Só os parâmetros dados mudam, sobre o template implantado: o change set mexe só nas regras de
  # entrada do SG (e na VM, só com --instance-type).
  update_parameters bb-srv-signal shared "${changes[@]}"
fi

# O wrangler da versão fixada no próprio fork (catálogo do package.json), rodado de apps/auth-api,
# onde está o wrangler.jsonc do Worker. Nunca a versão mais nova da rede.
wrangler=$(git -C "$BB_FORK" show "$sha:package.json" 2>/dev/null | jq -r '.workspaces.catalog.wrangler // .catalog.wrangler // empty' || true)
if [[ $wrangler =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  wrangler_cmd="bunx wrangler@$wrangler"
else
  warn "não achei a versão exata do wrangler no catálogo do package.json de $sha: use o wrangler que o lockfile instalou (bun install no fork)."
  wrangler_cmd="$BB_FORK/node_modules/.bin/wrangler"
fi

cat <<EOF

== Próximos passos
1. Esperar o primeiro boot (build das imagens e certificado: ~15 a 25 min) e conferir:
     curl -fsS https://signal.$zone/health/turn     (precisa de --approve-ingress)
     scripts/status.sh
2. Só depois, no Worker de contas (apps/auth-api, com wrangler login, pelo dev com o OK do dono):
     REMOTE_SIGNAL_URL        = $(stack_output bb-srv-signal SignalUrl)
     REMOTE_AUTH_WEBHOOK_URL  = $(stack_output bb-srv-signal AuthWebhookUrl)
     REMOTE_AUTH_WEBHOOK_SECRET (segredo do Worker), sem exibir o valor, com o wrangler fixado no fork:
       aws --profile cb --region us-east-1 ssm get-parameter --with-decryption \\
         --name /bb-srv/signal/remote-auth-webhook-secret --query Parameter.Value --output text \\
         | (cd "$BB_FORK/apps/auth-api" && $wrangler_cmd secret put REMOTE_AUTH_WEBHOOK_SECRET)
EOF
