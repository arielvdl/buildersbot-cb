#!/usr/bin/env bash
# Remove um setor sem perder dados (DESIGN 8.2):
#   1. confirma que a conta dona já removeu o servidor no app (só isso tira o host do D1);
#   2. encerra a sessão da conta dona no servidor e para o container (bb-srv-Down, logout=true). Com a
#      VM parada (setor em horário comercial), liga a VM para isso; sem logout confirmado, só segue
#      com uma confirmação digitada (a sessão fica no snapshot e volta numa restauração);
#   3. para a VM e TIRA UM SNAPSHOT do volume de dados (espera ficar completo);
#   4. apaga a stack -compute e depois a -data (que ainda deixa o snapshot final da DeletionPolicy);
#   5. grava /bb-srv/sectors/<setor>/final-snapshot, ajusta o budget do projeto e mostra como recriar.
#
# Uso: scripts/remove-sector.sh <setor> [--keep-days 180] [--app-removed] [--keep-registration] [--yes]
#   --keep-days N        data (tag ExpiresAt) a partir da qual scripts/gc-snapshots.sh pode apagar o
#                        snapshot; nada apaga sozinho (padrão 180)
#   --keep-registration  para restaurar o mesmo servidor logo depois (rollback de upgrade, troca de
#                        disco): não pede a remoção no app e não encerra a sessão da conta dona.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

sector=${1:-}
[ -n "$sector" ] && [[ $sector != -* ]] || { sed -n '2,16p' "$0"; exit 1; }
shift
keep_days=180
app_removed=0
logout=true
while [ "$#" -gt 0 ]; do
  case $1 in
    --keep-days) keep_days=${2:-} ; shift 2 ;;
    --app-removed) app_removed=1 ; shift ;;
    --keep-registration) app_removed=1 ; logout=false ; shift ;;
    --yes) BB_SRV_YES=1 ; shift ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
valid_sector "$sector"
[[ $keep_days =~ ^[0-9]+$ ]] && [ "$keep_days" -ge 1 ] || die "--keep-days inválido."

bb_check_access --writes
compute_stack="bb-srv-$sector-compute"
data_stack="bb-srv-$sector-data"
volume=$(sector_volume "$sector")
instance=''
compute_status=$(stack_status "$compute_stack")
case $compute_status in
  NONE) ;;
  ROLLBACK_COMPLETE) say "   $compute_stack está em ROLLBACK_COMPLETE (a criação falhou; não há VM): ela também sai." ;;
  *_IN_PROGRESS) die "a stack $compute_stack está em $compute_status. Espere terminar." ;;
  *_FAILED) stack_failures "$compute_stack"; die "$(stack_recovery_help "$compute_stack" "$compute_status")" ;;
  *) instance=$(sector_instance "$sector") ;;
esac

say "== remover o setor $sector: instância ${instance:-nenhuma}, volume $volume"
say "   O snapshot fica guardado; depois de $keep_days dias (tag ExpiresAt) o scripts/gc-snapshots.sh pode apagá-lo. Os alarmes, logs e o budget do setor saem com a stack."
if [ "$app_removed" != 1 ]; then
  say "   Antes: a conta dona do setor remove o servidor no app (Configurações do servidor -> Remover)."
  say "   'openbot logout' só encerra a sessão; o host continua registrado e contando no limite de membros."
  confirm "A conta dona já removeu o servidor '$sector' no app? Digite 'removido':" removido
fi
confirm "Remover o setor '$sector'? Digite o nome do setor:" "$sector"

without_logout() { # <motivo>
  warn "$1"
  BB_SRV_YES=0 confirm "Seguir SEM o logout? A sessão da conta dona fica no snapshot e volta se ele for restaurado. Digite 'sessao-no-snapshot':" sessao-no-snapshot
}

if [ -n "$instance" ]; then
  state=$(aws_cb ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].State.Name' --output text)
  case $state in
    pending) aws_cb ec2 wait instance-running --instance-ids "$instance"; state=running ;;
    stopping) aws_cb ec2 wait instance-stopped --instance-ids "$instance"; state=stopped ;;
  esac
  if [ "$state" = stopped ] && [ "$logout" = true ]; then
    # O logout precisa do container no ar: sem ele, a sessão da conta dona fica no /data do snapshot.
    say "== a VM está parada: ligando para encerrar a sessão da conta dona antes do snapshot"
    if aws_cb ec2 start-instances --instance-ids "$instance" >/dev/null &&
      aws_cb ec2 wait instance-running --instance-ids "$instance" && wait_ssm_online "$instance" 900; then
      state=running
    else
      without_logout "não consegui ligar a VM $instance ou ela não ficou Online no SSM."
    fi
  fi
  if [ "$state" = running ]; then
    say "== parando o container (logout da conta dona: $logout)"
    if ssm_run "$instance" bb-srv-Down "{\"logout\":[\"$logout\"]}" 600 "/bb-srv/$sector"; then
      if [ "$logout" = true ] && ! grep -Eq '^BB_LOGOUT (ok|none)' <<<"$SSM_OUTPUT"; then
        without_logout "o bb-srv-Down não confirmou o logout da conta dona (veja a saída acima)."
      fi
    else
      [ "$logout" != true ] || without_logout "bb-srv-Down falhou: o logout não foi confirmado."
      warn "bb-srv-Down falhou; a parada da VM ainda deixa o disco consistente (o OpenBot tem 60 s para fechar os bancos)."
    fi
    aws_cb ec2 stop-instances --instance-ids "$instance" >/dev/null
  fi
  aws_cb ec2 wait instance-stopped --instance-ids "$instance"
  say "   instância $instance parada."
fi

say "== snapshot do volume $volume antes de apagar qualquer coisa"
snapshot=$(snapshot_volume "$sector" "$volume" pre-remove "$keep_days")
aws_cb ssm put-parameter --name "/bb-srv/sectors/$sector/final-snapshot" --type String --overwrite \
  --value "$snapshot" --description "Snapshot final do setor $sector (removido em $(date -u +%F))" >/dev/null
say "   snapshot $snapshot completo e gravado em /bb-srv/sectors/$sector/final-snapshot."

if [ "$compute_status" != NONE ]; then
  [ -z "$instance" ] || aws_cb ec2 modify-instance-attribute --instance-id "$instance" --no-disable-api-termination
  say "== apagando $compute_stack"
  aws_cb cloudformation delete-stack --stack-name "$compute_stack"
  if ! aws_cb cloudformation wait stack-delete-complete --stack-name "$compute_stack"; then
    stack_failures "$compute_stack"
    die "a remoção de $compute_stack falhou. O snapshot $snapshot está seguro. $(stack_recovery_help "$compute_stack" "$(stack_status "$compute_stack")")"
  fi
fi
say "== apagando $data_stack (a DeletionPolicy ainda faz um snapshot final)"
aws_cb cloudformation delete-stack --stack-name "$data_stack"
if ! aws_cb cloudformation wait stack-delete-complete --stack-name "$data_stack"; then
  stack_failures "$data_stack"
  die "a remoção de $data_stack falhou. O snapshot $snapshot está seguro. $(stack_recovery_help "$data_stack" "$(stack_status "$data_stack")")"
fi

# Marca o snapshot da DeletionPolicy com o setor e o prazo, para a regra de restauração e a limpeza.
for extra in $(aws_cb ec2 describe-snapshots --owner-ids self --filters "Name=volume-id,Values=$volume" \
  --query "Snapshots[?SnapshotId!='$snapshot' && !(Tags[?Key=='Sector'])].SnapshotId" --output text); do
  aws_cb ec2 create-tags --resources "$extra" --tags "Key=Sector,Value=$sector" "Key=CostCenter,Value=$sector" \
    "Key=Project,Value=$BB_PROJECT" "Key=Purpose,Value=final" "Key=ExpiresAt,Value=$(date_plus_days "$keep_days")"
done

sync_project_budget

cat <<EOF

== Setor $sector removido. Dados no snapshot $snapshot (guardado; o scripts/gc-snapshots.sh pode
apagá-lo a partir de $(date_plus_days "$keep_days"), quando você rodar com --delete).
Recriar o mesmo servidor (mesma identidade, agentes e conversas; precisa de novo login):
  scripts/add-sector.sh $sector --from-snapshot $snapshot
Os snapshots do DLM deste setor expiram sozinhos (7 e 28 dias), menos o último de cada agenda, que o
DLM guarda para sempre: o scripts/gc-snapshots.sh apaga esses depois de 28 dias.
EOF
