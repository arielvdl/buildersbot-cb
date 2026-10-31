#!/usr/bin/env bash
# Cria um setor: uma VM dedicada com um servidor Builders Bot (DESIGN 8.1).
#   1. confere acesso, nome, cota de vCPU, imagem aprovada (relatório do builder + ECR + scan) e AMI;
#   2. stack bb-srv-<setor>-data (volume de dados, ou restaurado de um snapshot do mesmo setor). Se ela
#      já existe sem a VM (VM trocada, ou falha anterior da stack -compute), reaproveita o volume;
#   3. stack bb-srv-<setor>-compute (VM, role, logs, alarmes, budget, agenda), com a VM SEM proteção
#      contra término: uma falha na criação desfaz tudo (ROLLBACK_COMPLETE), sem ROLLBACK_FAILED;
#   4. espera o SSM e roda bb-srv-Install com os digests (create, attach ou auto: o disco decide);
#   5. grava /bb-srv/sectors/<setor>/image com a imagem que o host roda e liga a proteção contra
#      término (segundo change set, só esse parâmetro e a tag da imagem).
#
# Uso: scripts/add-sector.sh <setor> [medium|large|xlarge|steady|x86] [opções]
#   --volume-gib N            disco de dados em GiB (padrão 40; o disco do container é N-4)
#   --az a|b                  zona (padrão: alterna a/b pelo número de setores)
#   --schedule always-on|business-hours   (padrão always-on)
#   --static-ip               IP fixo (Elastic IP) para logins em redes sociais
#   --budget-usd N            budget mensal do setor (padrão 80)
#   --budget-email E          e-mail extra dos avisos do budget
#   --image-tag T             tag de um relatório do builder (padrão: o mais novo da arquitetura). Num
#                             disco já instalado (attach) a imagem é a do .env do disco, e a tag só
#                             escolhe o bundle de operação
#   --from-snapshot snap-...  restaura um setor removido (mesma identidade; novo login)
#   --i-know-cross-sector     aceita um snapshot de OUTRO setor (pede confirmação digitada)
#   --reattach                VM nova (stack -compute) sobre o volume de dados que já existe (VM com
#                             defeito ou AMI nova; apague a stack -compute antes). Sem a opção, rodar de
#                             novo depois de uma falha da stack -compute faz o mesmo
#   --resume                  termina um setor cuja stack -compute existe: repete o bb-srv-Install
#                             (modo auto) se a instalação falhou ou não terminou, e liga a proteção
#                             contra término se ainda estiver desligada
#   --yes                     não pergunta (para automação)
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

sector=${1:-}
[ -n "$sector" ] && [[ $sector != -* ]] || { sed -n '2,30p' "$0"; exit 1; }
shift
size=large
size_given=0
if [ "$#" -gt 0 ] && [[ $1 != -* ]]; then size=$1; size_given=1; shift; fi
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
resume=0
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
    --resume) resume=1 ; shift ;;
    --yes) BB_SRV_YES=1 ; shift ;;
    *) die "opção desconhecida: $1" ;;
  esac
done

valid_sector "$sector"
# A atribuição propaga o erro de size_info (um die dentro de $(...) só sairia do subshell).
info=$(size_info "$size") || exit 1
[[ $volume_gib =~ ^[0-9]+$ ]] && [ "$volume_gib" -ge 20 ] && [ "$volume_gib" -le 2000 ] || die "--volume-gib precisa ficar entre 20 e 2000."
[[ $budget_usd =~ ^[0-9]+$ ]] || die "--budget-usd precisa ser inteiro."
case $schedule in always-on | business-hours) ;; *) die "--schedule precisa ser always-on ou business-hours." ;; esac
[ -z "$budget_email" ] || valid_email "$budget_email"
[ -z "$from_snapshot" ] || [[ $from_snapshot =~ ^snap-[0-9a-f]{8,17}$ ]] || die "--from-snapshot inválido."
[ -z "$az" ] || [ "$az" = a ] || [ "$az" = b ] || die "--az precisa ser a ou b."
[ "$reattach" = 0 ] || [ -z "$from_snapshot" ] || die "--reattach e --from-snapshot não combinam."
[ "$resume" = 0 ] || { [ -z "$from_snapshot" ] && [ "$reattach" = 0 ]; } || die "--resume não combina com --from-snapshot nem com --reattach."

bb_check_access
require_stack bb-srv-base "Rode scripts/deploy-base.sh antes."
require_stack bb-srv-ops "Rode scripts/deploy-base.sh antes."
[ "$(stack_status bb-srv-signal)" != NONE ] || warn "a stack bb-srv-signal não existe: o setor sobe, mas ninguém conecta nele até o Signal próprio estar no ar (README, passo 4)."

data_stack="bb-srv-$sector-data"
compute_stack="bb-srv-$sector-compute"
compute_status=$(stack_status "$compute_stack")
install=1
mode=''

if [ "$resume" = 1 ]; then
  case $compute_status in
    CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE) ;;
    NONE) die "o setor $sector não tem a stack $compute_stack: rode sem --resume." ;;
    *) stack_failures "$compute_stack"; die "$(stack_recovery_help "$compute_stack" "$compute_status")" ;;
  esac
  stack_size=$(stack_parameter "$compute_stack" Size)
  [ "$size_given" = 0 ] || [ "$size" = "$stack_size" ] || die "o setor $sector foi criado como $stack_size; --resume não troca o tamanho."
  size=$stack_size
  info=$(size_info "$size") || exit 1
  if aws_cb ssm get-parameter --name "/bb-srv/sectors/$sector/image" >/dev/null 2>&1; then install=0; fi
  if [ "$install" = 0 ] && [ "$(stack_parameter "$compute_stack" TerminationProtection)" = true ]; then
    die "o setor $sector já está instalado e protegido: nada a retomar. Veja scripts/status.sh $sector --deep."
  fi
fi
read -r instance_type vcpus mem cpus tmp arch <<<"$info"

if [ "$resume" = 1 ]; then
  instance=$(sector_instance "$sector")
  volume_gib=$(aws_cb ec2 describe-volumes --volume-ids "$(sector_volume "$sector")" --query 'Volumes[0].Size' --output text)
  say "== retomar o setor $sector ($instance_type, VM $instance): instalar: $([ "$install" = 1 ] && echo sim || echo não), proteção contra término: ligar"
  if [ "$install" = 1 ]; then
    resolve_image "$image_tag" "$arch"
    state=$(aws_cb ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].State.Name' --output text)
    case $state in
      running | pending) ;;
      stopping | stopped)
        [ "$state" = stopped ] || aws_cb ec2 wait instance-stopped --instance-ids "$instance"
        say "== a VM está parada (agenda de horário comercial?): ligando"
        aws_cb ec2 start-instances --instance-ids "$instance" >/dev/null
        aws_cb ec2 wait instance-running --instance-ids "$instance"
        ;;
      *) die "a VM $instance está em $state." ;;
    esac
    # O disco decide: com o .env do setor (create parcial ou disco restaurado) é attach, sem ele é create.
    mode=auto
  fi
else
  if [ "$compute_status" != NONE ]; then
    die "o setor $sector já existe ($compute_stack: $compute_status). Se a instalação falhou ou não terminou: scripts/add-sector.sh $sector --resume. Para trocar a VM: README, seção 11 ('VM com defeito'). Estado: scripts/status.sh $sector."
  fi
  data_status=$(stack_status "$data_stack")
  [ "$reattach" = 0 ] || require_stack "$data_stack" "--reattach precisa do volume de dados do setor."
  if [ -n "$from_snapshot" ]; then
    [ "$data_status" = NONE ] || die "$data_stack já existe: uma restauração recria o volume. Remova o setor antes."
    read -r snap_state snap_sector snap_size <<<"$(aws_cb ec2 describe-snapshots --snapshot-ids "$from_snapshot" \
      --query "Snapshots[0].[State, Tags[?Key=='Sector']|[0].Value, VolumeSize]" --output text)"
    [ "$snap_state" = completed ] || die "o snapshot $from_snapshot está em $snap_state."
    if [ "$snap_sector" != "$sector" ]; then
      # Restaurar o snapshot de outro setor entrega os dados e os logins dele a este setor (DESIGN 8.2).
      [ "$cross_sector" = 1 ] || die "o snapshot $from_snapshot é do setor '$snap_sector', não de '$sector'. Recusado."
      BB_SRV_YES=0 confirm "Snapshot de '$snap_sector' em '$sector': os membros de '$sector' verão os dados e logins de '$snap_sector'. Digite '$snap_sector-para-$sector':" "$snap_sector-para-$sector"
    fi
    [ "$volume_gib" -ge "$snap_size" ] || volume_gib=$snap_size
    mode=attach
  elif [ "$data_status" != NONE ]; then
    # O volume do setor existe sem a VM: troca de VM (--reattach) ou nova tentativa depois de uma falha
    # da stack -compute. O bb-srv-Install decide pelo disco (auto): com o .env, attach; sem ele, create.
    require_stack "$data_stack" "O volume do setor está numa stack instável."
    volume_gib=$(aws_cb ec2 describe-volumes --volume-ids "$(sector_volume "$sector")" --query 'Volumes[0].Size' --output text)
    volume_zone=$(stack_output "$data_stack" AvailabilityZone)
    [ -z "$az" ] || [ "us-east-1$az" = "$volume_zone" ] || die "o volume de $sector está em $volume_zone; a VM tem de ir para a mesma zona (sem --az)."
    az=${volume_zone#us-east-1}
    say "   $data_stack já existe: a VM nova usa esse volume (bb-srv-Install em modo auto)."
    mode=auto
  else
    mode=create
  fi
  if [ -z "$az" ]; then
    count=$(aws_cb cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
      --query "length(StackSummaries[?starts_with(StackName,'bb-srv-') && ends_with(StackName,'-compute')])" --output text)
    if [ $((count % 2)) = 0 ]; then az=a; else az=b; fi
  fi
  zone="us-east-1$az"

  say "== setor $sector: $instance_type ($size), $zone, disco $volume_gib GiB, $schedule, IP fixo: $static_ip"
  check_vcpu_quota "$vcpus"
  resolve_image "$image_tag" "$arch"
  ami=$(ubuntu_ami "$arch")
  [[ $ami =~ ^ami-[0-9a-f]+$ ]] || die "não consegui resolver a AMI do Ubuntu 24.04 $arch."
  say "   AMI $ami (fixada; trocar só pela recriação da VM)"

  if [ "$data_status" = NONE ]; then
    deploy_stack "$data_stack" "$BB_ROOT/templates/sector-data.yaml" "$sector" \
      "ParameterKey=Sector,ParameterValue=$sector" \
      "ParameterKey=AvailabilityZone,ParameterValue=$zone" \
      "ParameterKey=DataVolumeGiB,ParameterValue=$volume_gib" \
      "ParameterKey=DataSnapshotId,ParameterValue=$from_snapshot"
  fi
  volume=$(sector_volume "$sector")
  [ "$(aws_cb ec2 describe-volumes --volume-ids "$volume" --query 'Volumes[0].State' --output text)" = available ] ||
    die "o volume $volume não está livre (available). Pare e apague a VM antiga antes."

  # Sem proteção contra término na criação: se algo falhar depois da VM, o rollback consegue apagá-la.
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
    "ParameterKey=BudgetEmail,ParameterValue=$budget_email" \
    "ParameterKey=TerminationProtection,ParameterValue=false"
  instance=$(sector_instance "$sector")
fi

if [ "$install" = 1 ]; then
  say "== esperando o SSM da instância $instance (até 15 min)"
  wait_ssm_online "$instance" 900 ||
    die "a instância $instance não ficou Online no SSM. Veja ec2 get-console-output e /var/log/bb-srv-bootstrap.log; depois: scripts/add-sector.sh $sector --resume."
  params=$(jq -cn --arg mode "$mode" --arg image "$IMAGE_DIGEST" --arg ops "$OPS_DIGEST" --arg cpus "$cpus" \
    --arg mem "$mem" --arg disk "$((volume_gib - 4))G" --arg tmp "$tmp" \
    '{mode: [$mode], imageDigest: [$image], opsDigest: [$ops], cpus: [$cpus], mem: [$mem], disk: [$disk], tmp: [$tmp]}')
  say "== instalando ($mode) com bb-srv-Install (bootstrap, pull ~1,5 GB e setup: ~10 min)"
  ssm_run "$instance" bb-srv-Install "$params" 2700 "/bb-srv/$sector" ||
    die "a instalação falhou. Leia a saída acima e o log /bb-srv/$sector. Corrigida a causa: scripts/add-sector.sh $sector --resume."

  # A imagem que o host roda de fato: no attach é a do .env do disco, não a do relatório mais novo.
  running=$(sed -n 's/^BB_IMAGE //p' <<<"$SSM_OUTPUT" | tail -n 1)
  [[ $running =~ ^[A-Za-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] ||
    die "o bb-srv-Install não informou a imagem em uso (linha BB_IMAGE). Confira com scripts/status.sh $sector --deep antes de gravar /bb-srv/sectors/$sector/image."
  [ "$running" = "$(repo_uri)@$IMAGE_DIGEST" ] || say "   o disco roda $running (não a imagem do relatório $IMAGE_TAG): é ela que fica registrada."
  aws_cb ssm put-parameter --name "/bb-srv/sectors/$sector/image" --type String --overwrite \
    --value "$running" --description "Imagem em uso no setor $sector (digest)" >/dev/null
else
  running=$(aws_cb ssm get-parameter --name "/bb-srv/sectors/$sector/image" --query Parameter.Value --output text)
fi

say "== proteção contra término da VM (e a tag da imagem em uso na stack)"
protect_sector "$sector" "$(image_tag_of "${running##*@}" "$arch")"

cat <<EOF

== Setor $sector no ar (ainda sem conta).
Próximo passo (o código chega na caixa da conta dona do setor; nunca use a conta pessoal do Ariel):
  scripts/login-sector.sh $sector bb-$sector@culturabuilder.com "CB $sector"
Depois, com a conta dona num perfil separado do app: Configurações do servidor -> Membros ->
Convidar pessoas -> Link de convite (uso único, função Admin) -> enviar ao Ariel (README, seção App).
EOF
