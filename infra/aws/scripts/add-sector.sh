#!/usr/bin/env bash
# Cria um setor: uma VM dedicada com um servidor Builders Bot (DESIGN 8.1).
#   1. confere acesso, nome, cota de vCPU, imagem aprovada (relatório do builder + ECR + scan) e AMI;
#   2. stack bb-srv-<setor>-data (volume de dados, ou restaurado de um snapshot do mesmo setor);
#   3. stack bb-srv-<setor>-compute (VM, role, logs, alarmes, budget, agenda);
#   4. espera o SSM e roda bb-srv-Install com os digests (create ou attach);
#   5. grava /bb-srv/sectors/<setor>/image e mostra o login do servidor.
#
# Uso: scripts/add-sector.sh <setor> [medium|large|xlarge|steady|x86] [opções]
#   --volume-gib N            disco de dados em GiB (padrão 40; o disco do container é N-4)
#   --az a|b                  zona (padrão: alterna a/b pelo número de setores)
#   --schedule always-on|business-hours   (padrão always-on)
#   --static-ip               IP fixo (Elastic IP) para logins em redes sociais
#   --budget-usd N            budget mensal do setor (padrão 80)
#   --budget-email E          e-mail extra dos avisos do budget
#   --image-tag T             tag de um relatório do builder (padrão: o mais novo da arquitetura)
#   --from-snapshot snap-...  restaura um setor removido (mesma identidade; novo login)
#   --i-know-cross-sector     aceita um snapshot de OUTRO setor (pede confirmação digitada)
#   --reattach                recria só a VM (stack -compute) sobre o volume de dados que já existe
#                             (VM com defeito ou AMI nova; apague a stack -compute antes)
#   --yes                     não pergunta (para automação)
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

sector=${1:-}
[ -n "$sector" ] && [[ $sector != -* ]] || { sed -n '2,20p' "$0"; exit 1; }
shift
size=large
if [ "$#" -gt 0 ] && [[ $1 != -* ]]; then size=$1; shift; fi
volume_gib=40
az=''
schedule=always-on
static_ip=false
budget_usd=80
budget_email=''
image_tag=''
from_snapshot=''
cross_sector=0
reattach=0
while [ "$#" -gt 0 ]; do
  case $1 in
    --volume-gib) volume_gib=${2:-} ; shift 2 ;;
    --az) az=${2:-} ; shift 2 ;;
    --schedule) schedule=${2:-} ; shift 2 ;;
    --static-ip) static_ip=true ; shift ;;
    --budget-usd) budget_usd=${2:-} ; shift 2 ;;
    --budget-email) budget_email=${2:-} ; shift 2 ;;
    --image-tag) image_tag=${2:-} ; shift 2 ;;
    --from-snapshot) from_snapshot=${2:-} ; shift 2 ;;
    --i-know-cross-sector) cross_sector=1 ; shift ;;
    --reattach) reattach=1 ; shift ;;
    --yes) BB_SRV_YES=1 ; shift ;;
    *) die "opção desconhecida: $1" ;;
  esac
done

valid_sector "$sector"
# A atribuição propaga o erro de size_info (um die dentro de $(...) só sairia do subshell).
info=$(size_info "$size") || exit 1
read -r instance_type vcpus mem cpus tmp arch <<<"$info"
[[ $volume_gib =~ ^[0-9]+$ ]] && [ "$volume_gib" -ge 20 ] && [ "$volume_gib" -le 2000 ] || die "--volume-gib precisa ficar entre 20 e 2000."
[[ $budget_usd =~ ^[0-9]+$ ]] || die "--budget-usd precisa ser inteiro."
case $schedule in always-on | business-hours) ;; *) die "--schedule precisa ser always-on ou business-hours." ;; esac
[ -z "$budget_email" ] || valid_email "$budget_email"
[ -z "$from_snapshot" ] || [[ $from_snapshot =~ ^snap-[0-9a-f]{8,17}$ ]] || die "--from-snapshot inválido."

bb_check_access
require_stack bb-srv-base "Rode scripts/deploy-base.sh antes."
require_stack bb-srv-ops "Rode scripts/deploy-base.sh antes."
[ "$(stack_status bb-srv-signal)" != NONE ] || warn "a stack bb-srv-signal não existe: o setor sobe, mas ninguém conecta nele até o Signal próprio estar no ar (README, passo 4)."

data_stack="bb-srv-$sector-data"
compute_stack="bb-srv-$sector-compute"
[ "$(stack_status "$compute_stack")" = NONE ] || die "o setor $sector já existe ($compute_stack). Use scripts/status.sh $sector."
if [ "$reattach" = 1 ]; then
  [ -z "$from_snapshot" ] || die "--reattach e --from-snapshot não combinam."
  require_stack "$data_stack" "--reattach precisa do volume de dados do setor."
  volume_gib=$(aws_cb ec2 describe-volumes --volume-ids "$(sector_volume "$sector")" --query 'Volumes[0].Size' --output text)
elif [ "$(stack_status "$data_stack")" != NONE ] && [ -z "$from_snapshot" ]; then
  die "$data_stack já existe sem a VM. Para recriar só a VM sobre esse disco, use --reattach."
fi
if [ -n "$from_snapshot" ]; then
  [ "$(stack_status "$data_stack")" = NONE ] || die "$data_stack já existe: uma restauração recria o volume. Remova o setor antes."
  read -r snap_state snap_sector snap_size <<<"$(aws_cb ec2 describe-snapshots --snapshot-ids "$from_snapshot" \
    --query "Snapshots[0].[State, Tags[?Key=='Sector']|[0].Value, VolumeSize]" --output text)"
  [ "$snap_state" = completed ] || die "o snapshot $from_snapshot está em $snap_state."
  if [ "$snap_sector" != "$sector" ]; then
    # Restaurar o snapshot de outro setor entrega os dados e os logins dele a este setor (DESIGN 8.2).
    [ "$cross_sector" = 1 ] || die "o snapshot $from_snapshot é do setor '$snap_sector', não de '$sector'. Recusado."
    BB_SRV_YES=0 confirm "Snapshot de '$snap_sector' em '$sector': os membros de '$sector' verão os dados e logins de '$snap_sector'. Digite '$snap_sector-para-$sector':" "$snap_sector-para-$sector"
  fi
  [ "$volume_gib" -ge "$snap_size" ] || volume_gib=$snap_size
fi

if [ -z "$az" ] || [ "$reattach" = 1 ]; then
  # O EBS fica preso a uma zona: com o volume existente, a VM vai para a zona dele.
  if [ "$(stack_status "$data_stack")" != NONE ]; then
    az=$(stack_output "$data_stack" AvailabilityZone)
    az=${az#us-east-1}
  else
    count=$(aws_cb cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
      --query "length(StackSummaries[?starts_with(StackName,'bb-srv-') && ends_with(StackName,'-compute')])" --output text)
    if [ $((count % 2)) = 0 ]; then az=a; else az=b; fi
  fi
fi
case $az in a | b) zone="us-east-1$az" ;; *) die "--az precisa ser a ou b." ;; esac

say "== setor $sector: $instance_type ($size), $zone, disco $volume_gib GiB, $schedule, IP fixo: $static_ip"
check_vcpu_quota "$vcpus"
resolve_image "$image_tag" "$arch"
ami=$(ubuntu_ami "$arch")
[[ $ami =~ ^ami-[0-9a-f]+$ ]] || die "não consegui resolver a AMI do Ubuntu 24.04 $arch."
say "   AMI $ami (fixada; trocar só pela recriação da VM)"

if [ "$reattach" = 0 ]; then
  deploy_stack "$data_stack" "$BB_ROOT/templates/sector-data.yaml" "$sector" \
    "ParameterKey=Sector,ParameterValue=$sector" \
    "ParameterKey=AvailabilityZone,ParameterValue=$zone" \
    "ParameterKey=DataVolumeGiB,ParameterValue=$volume_gib" \
    "ParameterKey=DataSnapshotId,ParameterValue=$from_snapshot"
fi
volume=$(sector_volume "$sector")
[ "$(aws_cb ec2 describe-volumes --volume-ids "$volume" --query 'Volumes[0].State' --output text)" = available ] ||
  die "o volume $volume não está livre (available). Pare e apague a VM antiga antes."

deploy_stack "$compute_stack" "$BB_ROOT/templates/sector-compute.yaml" "$sector" \
  "ParameterKey=Sector,ParameterValue=$sector" \
  "ParameterKey=Size,ParameterValue=$size" \
  "ParameterKey=AvailabilityZone,ParameterValue=$zone" \
  "ParameterKey=DataVolumeId,ParameterValue=$volume" \
  "ParameterKey=AmiId,ParameterValue=$ami" \
  "ParameterKey=ImageTag,ParameterValue=$IMAGE_TAG" \
  "ParameterKey=Schedule,ParameterValue=$schedule" \
  "ParameterKey=StaticIp,ParameterValue=$static_ip" \
  "ParameterKey=BudgetUsd,ParameterValue=$budget_usd" \
  "ParameterKey=BudgetEmail,ParameterValue=$budget_email"
instance=$(sector_instance "$sector")

say "== esperando o SSM da instância $instance (até 15 min)"
wait_ssm_online "$instance" 900 || die "a instância $instance não ficou Online no SSM. Veja ec2 get-console-output e /var/log/bb-srv-bootstrap.log."

mode=create
if [ -n "$from_snapshot" ] || [ "$reattach" = 1 ]; then mode=attach; fi
params=$(jq -cn --arg mode "$mode" --arg image "$IMAGE_DIGEST" --arg ops "$OPS_DIGEST" --arg cpus "$cpus" \
  --arg mem "$mem" --arg disk "$((volume_gib - 4))G" --arg tmp "$tmp" \
  '{mode: [$mode], imageDigest: [$image], opsDigest: [$ops], cpus: [$cpus], mem: [$mem], disk: [$disk], tmp: [$tmp]}')
say "== instalando ($mode) com bb-srv-Install (bootstrap, pull ~1,5 GB e setup: ~10 min)"
ssm_run "$instance" bb-srv-Install "$params" 2700 "/bb-srv/$sector" || die "a instalação falhou. Leia a saída acima e o log /bb-srv/$sector."

aws_cb ssm put-parameter --name "/bb-srv/sectors/$sector/image" --type String --overwrite \
  --value "$(repo_uri)@$IMAGE_DIGEST" --description "Imagem em uso no setor $sector (digest)" >/dev/null

cat <<EOF

== Setor $sector no ar (ainda sem conta).
Próximo passo (o código chega na caixa da conta dona do setor; nunca use a conta pessoal do Ariel):
  scripts/login-sector.sh $sector bb-$sector@culturabuilder.com "CB $sector"
Depois, com a conta dona num perfil separado do app: Configurações do servidor -> Membros ->
Convidar pessoas -> Link de convite (uso único, função Admin) -> enviar ao Ariel (README, seção App).
EOF
