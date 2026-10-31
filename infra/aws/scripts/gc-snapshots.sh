#!/usr/bin/env bash
# Lista (padrão) ou apaga (--delete) os snapshots do projeto que já podem sair. Nada mais apaga
# snapshots por prazo: a tag ExpiresAt só tem efeito quando este script roda.
#   1. snapshots com a tag ExpiresAt anterior a hoje (pre-remove, final, pre-upgrade);
#   2. snapshots do DLM (tag aws:dlm:lifecycle-policy-id) de setores REMOVIDOS (sem stack -compute e
#      sem stack -data) com mais de N dias: o DLM guarda para sempre o último de cada agenda.
# Só olha snapshots desta conta com Project=buildersbot-servers. Não toca no snapshot gravado em
# /bb-srv/sectors/<setor>/final-snapshot antes do ExpiresAt dele.
#
# Uso: scripts/gc-snapshots.sh [--dlm-orphan-days 28] [--delete]
#   Sem --delete, só lista (leitura). --delete pede a confirmação digitada "apagar <N>" sempre.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

delete=0
orphan_days=28
while [ "$#" -gt 0 ]; do
  case $1 in
    --delete) delete=1 ; shift ;;
    --dlm-orphan-days) orphan_days=${2:-} ; shift 2 ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
[[ $orphan_days =~ ^[0-9]+$ ]] && [ "$orphan_days" -ge 7 ] || die "--dlm-orphan-days precisa ser um inteiro de 7 ou mais."

if [ "$delete" = 1 ]; then bb_check_access --writes; else bb_check_access; fi

today=$(date -u +%F)
cutoff=$(date_minus_days "$orphan_days")
candidates=''
count=0
listing=$(aws_cb ec2 describe-snapshots --owner-ids self --filters "Name=tag:Project,Values=$BB_PROJECT" \
  --query "Snapshots[].[SnapshotId, StartTime, Tags[?Key=='Sector']|[0].Value, Tags[?Key=='ExpiresAt']|[0].Value, Tags[?Key=='aws:dlm:lifecycle-policy-id']|[0].Value, VolumeSize]" \
  --output text)
say "== snapshots de $BB_PROJECT que podem sair (hoje $today; DLM órfão antes de $cutoff)"
while read -r id start sector expires dlm size; do
  [ -n "${id:-}" ] || continue
  reason=''
  if [ "$expires" != None ] && [[ $expires =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [[ $expires < $today ]]; then
    reason="ExpiresAt $expires"
  elif [ "$dlm" != None ] && [ "$sector" != None ] && [[ ${start:0:10} < $cutoff ]] &&
    [ "$(stack_status "bb-srv-$sector-compute")" = NONE ] && [ "$(stack_status "bb-srv-$sector-data")" = NONE ]; then
    reason="DLM de setor removido, de ${start:0:10}"
  fi
  [ -n "$reason" ] || continue
  say "   $id  setor ${sector/None/?}  ${size} GiB  $reason"
  candidates="$candidates $id"
  count=$((count + 1))
done <<<"$listing"

if [ "$count" = 0 ]; then
  say "   nenhum."
  exit 0
fi
if [ "$delete" = 0 ]; then
  say "$count snapshot(s). Para apagar: scripts/gc-snapshots.sh --delete"
  exit 0
fi
BB_SRV_YES=0 confirm "Apagar $count snapshot(s) para sempre? Digite 'apagar $count':" "apagar $count"
for id in $candidates; do
  aws_cb ec2 delete-snapshot --snapshot-id "$id"
  say "   $id apagado."
done
