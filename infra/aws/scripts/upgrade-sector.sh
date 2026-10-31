#!/usr/bin/env bash
# Atualiza a imagem de um setor para uma tag do builder (DESIGN 7.4):
#   1. confere o relatório, o ECR e o scan da tag;
#   2. baixa a imagem nova com o setor ainda no ar (bb-srv-Upgrade step=pull, que recusa versão antiga);
#   3. para o container (bb-srv-Down), tira o snapshot pre-upgrade (ExpiresAt em 30 dias: depois disso o
#      scripts/gc-snapshots.sh pode apagá-lo) e
#   4. troca a imagem e sobe (bb-srv-Upgrade step=apply); grava /bb-srv/sectors/<setor>/image.
# Recuperação: restaurar o snapshot pre-upgrade JUNTO com a imagem anterior (README, Recuperação).
#
# Uso: scripts/upgrade-sector.sh <setor> <tag> [--yes]
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

[ "$#" -ge 2 ] || { sed -n '2,11p' "$0"; exit 1; }
sector=$1
tag=$2
shift 2
while [ "$#" -gt 0 ]; do
  case $1 in
    --yes) BB_SRV_YES=1 ; shift ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
valid_sector "$sector"

bb_check_access --writes
instance=$(sector_instance "$sector")
volume=$(sector_volume "$sector")
type=$(aws_cb ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].InstanceType' --output text)
case $type in t3a.* | t3.* | m7i.* | c7i.*) arch=amd64 ;; *) arch=arm64 ;; esac
resolve_image "$tag" "$arch"
current=$(aws_cb ssm get-parameter --name "/bb-srv/sectors/$sector/image" --query Parameter.Value --output text 2>/dev/null || echo none)
say "== $sector: $current -> $(repo_uri)@$IMAGE_DIGEST"
confirm "Atualizar o setor $sector para $IMAGE_TAG (o setor fica fora do ar por ~1 a 2 min)? Digite 'sim':" sim

pull=$(jq -cn --arg d "$IMAGE_DIGEST" '{imageDigest: [$d], step: ["pull"]}')
apply=$(jq -cn --arg d "$IMAGE_DIGEST" '{imageDigest: [$d], step: ["apply"]}')
ssm_run "$instance" bb-srv-Upgrade "$pull" 1800 "/bb-srv/$sector" || die "o pull ou a checagem de versão falhou; nada mudou."
ssm_run "$instance" bb-srv-Down '{"logout":["false"]}' 400 "/bb-srv/$sector" || die "não consegui parar o container."
# O snapshot vale a partir do início: o container pode subir logo depois do create-snapshot.
snapshot=$(aws_cb ec2 create-snapshot --volume-id "$volume" --description "bb-srv $sector pre-upgrade $IMAGE_TAG" \
  --tag-specifications "ResourceType=snapshot,Tags=[{Key=Name,Value=bb-srv-$sector-pre-upgrade},{Key=Sector,Value=$sector},{Key=CostCenter,Value=$sector},{Key=Project,Value=$BB_PROJECT},{Key=Owner,Value=$BB_OWNER},{Key=Purpose,Value=pre-upgrade},{Key=PreviousImage,Value=${current##*@}},{Key=ExpiresAt,Value=$(date_plus_days 30)}]" \
  --query SnapshotId --output text)
say "   snapshot pre-upgrade $snapshot"
ssm_run "$instance" bb-srv-Upgrade "$apply" 1200 "/bb-srv/$sector" || die "a troca falhou. O snapshot $snapshot tem o estado anterior (com a imagem $current)."
aws_cb ssm put-parameter --name "/bb-srv/sectors/$sector/image" --type String --overwrite \
  --value "$(repo_uri)@$IMAGE_DIGEST" --description "Imagem em uso no setor $sector (digest)" >/dev/null
say "== $sector em $IMAGE_TAG. Snapshot de antes: $snapshot (o gc-snapshots.sh pode apagá-lo a partir de $(date_plus_days 30))."
