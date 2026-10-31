#!/usr/bin/env bash
# Mostra o estado da estrutura: stacks compartilhadas, delegação DNS, Signal e cada setor (VM, SSM,
# imagem, idade do último snapshot, alarmes em ALARM). Só leituras.
# Com <setor> --deep, roda também o documento bb-srv-Status no host (só leitura do host).
#
# Uso: scripts/status.sh [setor] [--deep]
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

only=''
deep=0
while [ "$#" -gt 0 ]; do
  case $1 in
    --deep) deep=1 ; shift ;;
    -h | --help) sed -n '2,6p' "$0"; exit 0 ;;
    -*) die "opção desconhecida: $1" ;;
    *) only=$1 ; shift ;;
  esac
done
[ -z "$only" ] || valid_sector "$only"
[ "$deep" = 0 ] || [ -n "$only" ] || die "--deep precisa de um setor."

bb_check_access

say "== compartilhado"
for stack in bb-srv-dns bb-srv-base bb-srv-ops bb-srv-signal; do
  printf '   %-16s %s\n' "$stack" "$(stack_status "$stack")"
done

if [ "$(stack_status bb-srv-dns)" != NONE ]; then
  zone=$(stack_output bb-srv-dns HostedZoneName)
  if command -v dig >/dev/null; then
    # Os NS públicos têm de ser os DESTA zona: outros NS são uma delegação pendurada (zona recriada).
    expected=$(aws_cb route53 get-hosted-zone --id "$(stack_output bb-srv-dns HostedZoneId)" \
      --query 'DelegationSet.NameServers' --output text 2>/dev/null | tr '\t' '\n' | sort || true)
    actual=$(dig +short NS "$zone" @1.1.1.1 | sed 's/\.$//' | sort || true)
    if [ -z "$actual" ]; then
      delegation="NÃO delegado (ação do dono no Cloudflare)"
    elif [ "$actual" = "$expected" ]; then
      delegation="delegado ao Route 53 (os 4 NS da zona bb-srv-dns)"
    else
      delegation="delegado a OUTROS name servers: refaça os 4 NS no Cloudflare com os da zona bb-srv-dns"
    fi
    printf '   DNS %-31s %s\n' "$zone" "$delegation"
  fi
  alarms=$(aws_cb cloudwatch describe-alarms --alarm-name-prefix bb-srv- --state-value ALARM --query 'MetricAlarms[].AlarmName' --output text)
  printf '   alarmes em ALARM: %s\n' "${alarms:-nenhum}"
fi

if [ "$(stack_status bb-srv-signal)" != NONE ]; then
  signal=$(stack_output bb-srv-signal InstanceId)
  printf '   signal %s %s, IP %s, portas abertas: %s\n' "$signal" \
    "$(aws_cb ec2 describe-instances --instance-ids "$signal" --query 'Reservations[0].Instances[0].State.Name' --output text)" \
    "$(stack_output bb-srv-signal SignalPublicIp)" "$(stack_output bb-srv-signal IngressOpen)"
fi

sectors=$(aws_cb cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE CREATE_IN_PROGRESS UPDATE_IN_PROGRESS \
  ROLLBACK_IN_PROGRESS ROLLBACK_COMPLETE ROLLBACK_FAILED UPDATE_ROLLBACK_FAILED DELETE_FAILED \
  --query "StackSummaries[?starts_with(StackName,'bb-srv-') && ends_with(StackName,'-compute')].StackName" --output text |
  tr '\t' '\n' | sed -e 's/^bb-srv-//' -e 's/-compute$//' | sort)
[ -z "$only" ] || sectors=$only

say "== setores"
[ -n "$sectors" ] || say "   nenhum."
now=$(date -u +%s)
for sector in $sectors; do
  stack="bb-srv-$sector-compute"
  status=$(stack_status "$stack")
  if [ "$status" = NONE ]; then
    say "   $sector: sem stack $stack"
    continue
  fi
  instance=$(stack_output "$stack" InstanceId 2>/dev/null || echo None)
  case $status in
    *_FAILED | ROLLBACK_COMPLETE)
      # Uma stack em falha não tem saídas: mostra o caminho de recuperação, com os comandos.
      say "   $sector [$status]"
      printf '%s\n' "$(stack_recovery_help "$stack" "$status")" | sed 's/^/      /'
      continue
      ;;
    *_IN_PROGRESS)
      say "   $sector [$status]: operação em andamento"
      continue
      ;;
  esac
  if [ -z "$instance" ] || [ "$instance" = None ]; then
    say "   $sector [$status]: sem VM na stack"
    continue
  fi
  read -r state type zone ip <<<"$(aws_cb ec2 describe-instances --instance-ids "$instance" \
    --query 'Reservations[0].Instances[0].[State.Name,InstanceType,Placement.AvailabilityZone,PublicIpAddress]' --output text)"
  ping=$(aws_cb ssm describe-instance-information --filters "Key=InstanceIds,Values=$instance" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo None)
  image=$(aws_cb ssm get-parameter --name "/bb-srv/sectors/$sector/image" --query Parameter.Value --output text 2>/dev/null || echo "")
  installed_on=$(aws_cb ssm get-parameter --name "/bb-srv/sectors/$sector/installed-instance" --query Parameter.Value --output text 2>/dev/null || echo "")
  if [ -n "$image" ] && [ "$installed_on" != "$instance" ]; then
    image="(não instalada nesta VM; a última imagem registrada foi $image: scripts/add-sector.sh $sector --resume)"
  elif [ -n "$image" ]; then
    case $type in t3a.* | t3.* | m7i.* | c7i.*) arch=amd64 ;; *) arch=arm64 ;; esac
    image="$(image_tag_of "${image##*@}" "$arch") ($image)"
  else
    image="(não instalada: scripts/add-sector.sh $sector --resume)"
  fi
  protection=$(stack_parameter "$stack" TerminationProtection 2>/dev/null || echo None)
  last=$(aws_cb ec2 describe-snapshots --owner-ids self --filters "Name=tag:Sector,Values=$sector" \
    --query 'sort_by(Snapshots,&StartTime)[-1].StartTime' --output text 2>/dev/null || echo None)
  if [ "$last" != None ] && [ -n "$last" ]; then
    epoch=$(date -u -j -f '%Y-%m-%dT%H:%M:%S' "${last:0:19}" +%s 2>/dev/null || date -u -d "$last" +%s)
    age="$(((now - epoch) / 3600)) h"
    [ $(((now - epoch) / 3600)) -le 26 ] || age="$age (ATRASADO: mais de 26 h)"
  else
    age="nenhum"
  fi
  alarms=$(aws_cb cloudwatch describe-alarms --alarm-name-prefix "bb-srv-$sector-" --state-value ALARM --query 'MetricAlarms[].AlarmName' --output text)
  say "   $sector [$status]"
  say "      VM $instance $state $type $zone IP ${ip:-sem IP} | SSM $ping | proteção contra término: $protection"
  say "      imagem em uso: $image"
  say "      último snapshot: $age | alarmes em ALARM: ${alarms:-nenhum}"
  if [ "$deep" = 1 ]; then
    [ "$ping" = Online ] || die "a instância não está Online no SSM."
    ssm_run "$instance" bb-srv-Status '{}' 180
  fi
done
