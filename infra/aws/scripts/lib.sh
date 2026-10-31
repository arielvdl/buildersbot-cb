#!/usr/bin/env bash
# shellcheck shell=bash
# Funções comuns dos scripts bb-srv. Carregue com `source`; não rode direto.
# Compatível com o bash 3.2 do macOS (sem arrays associativos nem mapfile).

set -euo pipefail

BB_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BB_REGION=us-east-1
BB_PROFILE=cb
BB_PROJECT=buildersbot-servers
BB_OWNER=cultura-builder
BB_REPO_NAME=bb-srv/server
BB_FORK=${BB_SRV_FORK:-/Users/arielsilva/Projects/openbot-local}
# Nomes que não podem ser setor: colidem com recursos compartilhados bb-srv-*.
BB_RESERVED=" base ops signal builder shared operator breakglass sectors alerts project host dlm scheduler "
# Folga de vCPU que fica para o Karpenter/EKS da conta (DESIGN 9.2).
BB_VCPU_RESERVE=${BB_SRV_VCPU_RESERVE:-16}

# shellcheck source=scripts/check-access.sh
source "$BB_ROOT/scripts/check-access.sh"

say() { printf '%s\n' "$*"; }
warn() { printf 'AVISO: %s\n' "$*" >&2; }
die() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}

# Todo comando AWS passa por aqui: perfil e região fixos.
aws_cb() { aws --profile "$BB_PROFILE" --region "$BB_REGION" "$@"; }

valid_sector() {
  [[ $1 =~ ^[a-z0-9][a-z0-9-]{0,23}$ ]] || die "nome de setor inválido: '$1'. Use 1 a 24 caracteres a-z, 0-9 e -, começando por letra ou dígito."
  case $BB_RESERVED in *" $1 "*) die "'$1' é um nome reservado. Escolha outro." ;; esac
}

valid_email() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]{0,189}\.[A-Za-z]{2,24}$ ]] || die "e-mail inválido: '$1'."
}

# Tamanho -> "tipo vcpus memória-do-container cpus-do-container tmpfs arquitetura budget-usd"
# (DESIGN 2.6). O budget padrão é ~1,25 x a estimativa 24/7 do tamanho (README, seção 9).
size_info() {
  case $1 in
    medium) echo "t4g.medium 2 3000m 2 1g arm64 50" ;;
    large) echo "t4g.large 2 6500m 2 3g arm64 80" ;;
    xlarge) echo "t4g.xlarge 4 14g 4 4g arm64 140" ;;
    steady) echo "m7g.large 2 6500m 2 3g arm64 95" ;;
    x86) echo "t3a.large 2 6500m 2 3g amd64 90" ;;
    *) die "tamanho inválido: '$1'. Use medium, large, xlarge, steady ou x86." ;;
  esac
}

date_plus_days() {
  date -u -v+"$1"d +%F 2>/dev/null || date -u -d "+$1 days" +%F
}

date_minus_days() {
  date -u -v-"$1"d +%F 2>/dev/null || date -u -d "-$1 days" +%F
}

# Pergunta e volta 0 só com a resposta exata; volta 1 (sem sair) com outra resposta ou sem terminal.
ask() { # <pergunta> <resposta esperada>
  if [ "${BB_SRV_YES:-0}" = 1 ]; then return 0; fi
  [ -t 0 ] || { warn "a confirmação precisa de um terminal (ou use --yes)."; return 1; }
  local answer=''
  printf '%s ' "$1" >&2
  read -r answer || return 1
  [ "$answer" = "$2" ]
}

confirm() { # <pergunta> <resposta esperada>
  ask "$1" "$2" || die "cancelado."
}

stack_status() {
  aws_cb cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE
}

stack_output() { # <stack> <OutputKey>
  aws_cb cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text
}

stack_parameter() { # <stack> <ParameterKey> -> valor atual do parâmetro (None se não existe)
  aws_cb cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Parameters[?ParameterKey=='$2'].ParameterValue | [0]" --output text
}

require_stack() {
  local status
  status=$(stack_status "$1")
  case $status in
    CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE) ;;
    *) die "a stack $1 precisa existir e estar estável (agora: $status). ${2:-}" ;;
  esac
}

stack_failures() {
  aws_cb cloudformation describe-stack-events --stack-name "$1" --max-items 40 \
    --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatus,ResourceStatusReason]" \
    --output table >&2 || true
}

# O que fazer com uma stack num estado de falha, com os comandos exatos (impresso pelo die).
stack_recovery_help() { # <stack> <status>
  local stack=$1 status=$2 instances id cli="aws --profile $BB_PROFILE --region $BB_REGION"
  case $status in
    ROLLBACK_COMPLETE)
      printf 'a stack %s está em ROLLBACK_COMPLETE (a criação falhou e foi desfeita; os eventos estão acima). Apague-a e rode de novo:\n  %s cloudformation delete-stack --stack-name %s\n  %s cloudformation wait stack-delete-complete --stack-name %s' \
        "$stack" "$cli" "$stack" "$cli" "$stack"
      ;;
    ROLLBACK_FAILED | DELETE_FAILED)
      # O caso típico: uma VM com proteção contra término que a CloudFormation não consegue apagar.
      instances=$(aws_cb cloudformation describe-stack-resources --stack-name "$stack" \
        --query "StackResources[?ResourceType=='AWS::EC2::Instance' && PhysicalResourceId!=null].PhysicalResourceId" \
        --output text 2>/dev/null || true)
      printf 'a stack %s está em %s: a CloudFormation não conseguiu apagar um recurso (eventos acima). Passos:\n' "$stack" "$status"
      for id in $instances; do
        case $id in i-*) printf '  %s ec2 modify-instance-attribute --instance-id %s --no-disable-api-termination\n' "$cli" "$id" ;; esac
      done
      printf '  %s cloudformation delete-stack --stack-name %s\n  %s cloudformation wait stack-delete-complete --stack-name %s\n' \
        "$cli" "$stack" "$cli" "$stack"
      printf 'Se o delete falhar de novo num recurso que deve ficar, repita com --retain-resources <LogicalResourceId> e resolva esse recurso à mão.'
      case $stack in bb-srv-*-compute) printf '\nDepois: scripts/add-sector.sh %s (reaproveita o volume de dados da stack -data).' "$(sed -e 's/^bb-srv-//' -e 's/-compute$//' <<<"$stack")" ;; esac
      ;;
    UPDATE_ROLLBACK_FAILED)
      printf 'a stack %s está em UPDATE_ROLLBACK_FAILED: o rollback de uma atualização parou (eventos acima). Corrija a causa e continue:\n  %s cloudformation continue-update-rollback --stack-name %s\n  %s cloudformation wait stack-rollback-complete --stack-name %s\n(um recurso que não volta pode ir em --resources-to-skip <LogicalResourceId>, e fica fora de sincronia)' \
        "$stack" "$cli" "$stack" "$cli" "$stack"
      ;;
    *)
      printf 'a stack %s está em %s. Leia os eventos (%s cloudformation describe-stack-events --stack-name %s) antes de qualquer ação.' \
        "$stack" "$status" "$cli" "$stack"
      ;;
  esac
}

# Apaga uma stack sem recursos (REVIEW_IN_PROGRESS: só teve change sets de criação não executados).
drop_empty_stack() { # <stack>
  say "   apagando a stack vazia $1 (REVIEW_IN_PROGRESS, sem recursos)"
  aws_cb cloudformation delete-stack --stack-name "$1" &&
    aws_cb cloudformation wait stack-delete-complete --stack-name "$1"
}

# Um change set que não vai ser executado sai, e numa criação também a stack vazia que ele deixou em
# REVIEW_IN_PROGRESS: sem isso, add-sector.sh e remove-sector.sh não conseguem seguir nem remover.
discard_change_set() { # <stack> <change set> <CREATE|UPDATE>
  aws_cb cloudformation delete-change-set --stack-name "$1" --change-set-name "$2" >/dev/null 2>&1 ||
    warn "não consegui apagar o change set $2 de $1."
  if [ "$3" = CREATE ] && [ "$(stack_status "$1")" = REVIEW_IN_PROGRESS ]; then
    drop_empty_stack "$1" || warn "não consegui apagar a stack vazia $1: aws --profile $BB_PROFILE --region $BB_REGION cloudformation delete-stack --stack-name $1"
  fi
}

# Cria um change set, mostra, recusa numa atualização a substituição ou remoção de instância, volume
# ou anexo (DESIGN R2-1) e da zona DNS, do ECR e dos buckets (nomes fixos, dados que não voltam, NS já
# delegados no Cloudflare), pede confirmação e executa. Parâmetros: ParameterKey=K,ParameterValue=V
# ou ParameterKey=K,UsePreviousValue=true. Template @previous = o template já implantado (só troca
# parâmetros; o arquivo local não entra). Um change set falho, recusado ou não confirmado é apagado
# (discard_change_set), com a stack vazia de uma criação.
deploy_stack() { # <stack> <template|@previous> <setor-para-tags> [parâmetros...]
  local stack=$1 template=$2 sector=$3 status type name reason risky after
  shift 3
  status=$(stack_status "$stack")
  case $status in
    NONE | REVIEW_IN_PROGRESS) type=CREATE ;;
    *_IN_PROGRESS) die "a stack $stack está em $status. Espere terminar." ;;
    ROLLBACK_COMPLETE | *_FAILED) stack_failures "$stack"; die "$(stack_recovery_help "$stack" "$status")" ;;
    *) type=UPDATE ;;
  esac
  [ "$template" != @previous ] || [ "$type" = UPDATE ] || die "a stack $stack não existe: não há template anterior."
  name="bb-srv-$(date -u +%Y%m%d%H%M%S)"
  say "== $stack: change set $name ($type)"
  local -a args=(--stack-name "$stack" --change-set-name "$name" --change-set-type "$type" --capabilities CAPABILITY_NAMED_IAM
    --tags "Key=Project,Value=$BB_PROJECT" "Key=Owner,Value=$BB_OWNER" "Key=ManagedBy,Value=cloudformation"
    "Key=Sector,Value=$sector" "Key=CostCenter,Value=$sector")
  if [ "$template" = @previous ]; then args+=(--use-previous-template); else args+=(--template-body "file://$template"); fi
  if [ "$#" -gt 0 ]; then args+=(--parameters "$@"); fi
  aws_cb cloudformation create-change-set "${args[@]}" >/dev/null
  if ! aws_cb cloudformation wait change-set-create-complete --stack-name "$stack" --change-set-name "$name" 2>/dev/null; then
    reason=$(aws_cb cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" --query StatusReason --output text 2>/dev/null || true)
    case $reason in
      *"didn't contain changes"* | *"No updates are to be performed"*)
        aws_cb cloudformation delete-change-set --stack-name "$stack" --change-set-name "$name" >/dev/null || true
        say "   sem mudanças em $stack."
        return 0
        ;;
    esac
    discard_change_set "$stack" "$name" "$type"
    die "o change set de $stack falhou: $reason"
  fi
  aws_cb cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" \
    --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' --output table ||
    { discard_change_set "$stack" "$name" "$type"; die "não consegui ler o change set $name de $stack."; }
  if [ "$type" = UPDATE ]; then
    risky=$(aws_cb cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" --output text \
      --query "Changes[?(ResourceChange.ResourceType=='AWS::EC2::Instance' || ResourceChange.ResourceType=='AWS::EC2::Volume' || ResourceChange.ResourceType=='AWS::EC2::VolumeAttachment' || ResourceChange.ResourceType=='AWS::Route53::HostedZone' || ResourceChange.ResourceType=='AWS::ECR::Repository' || ResourceChange.ResourceType=='AWS::S3::Bucket') && (ResourceChange.Action=='Remove' || (ResourceChange.Action=='Modify' && ResourceChange.Replacement!='False'))].ResourceChange.LogicalResourceId") ||
      { discard_change_set "$stack" "$name" "$type"; die "não consegui ler o change set $name de $stack: recusado sem a checagem de substituição."; }
    if [ -n "$risky" ] && [ "$risky" != None ]; then
      discard_change_set "$stack" "$name" "$type"
      die "recusado: este change set substitui ou remove $risky. VM, volume ou anexo: use o fluxo de troca de VM do README (seção 11). Zona DNS, ECR ou bucket: isso não se faz por atualização de stack (README, seção 11, 'Desfazer tudo')."
    fi
  fi
  if ! ask "Executar o change set $name em $stack? Digite 'sim':" sim; then
    discard_change_set "$stack" "$name" "$type"
    die "cancelado: o change set $name de $stack foi apagado e nada mudou."
  fi
  aws_cb cloudformation execute-change-set --stack-name "$stack" --change-set-name "$name"
  if [ "$type" = CREATE ]; then
    if ! aws_cb cloudformation wait stack-create-complete --stack-name "$stack"; then
      stack_failures "$stack"
      after=$(stack_status "$stack")
      die "a criação de $stack falhou. $(stack_recovery_help "$stack" "$after")"
    fi
  else
    if ! aws_cb cloudformation wait stack-update-complete --stack-name "$stack"; then
      stack_failures "$stack"
      after=$(stack_status "$stack")
      case $after in
        UPDATE_ROLLBACK_COMPLETE) die "a atualização de $stack falhou e foi desfeita (UPDATE_ROLLBACK_COMPLETE): nada mudou. Leia os eventos acima." ;;
        *) die "a atualização de $stack falhou. $(stack_recovery_help "$stack" "$after")" ;;
      esac
    fi
  fi
  say "   $stack: $(stack_status "$stack")"
}

# Tag <versão>-<sha7>-<arch> de um digest de bb-srv/server no ECR, ou none.
image_tag_of() { # <sha256:...> <arm64|amd64>
  local tag
  for tag in $(aws_cb ecr describe-images --repository-name "$BB_REPO_NAME" --image-ids "imageDigest=$1" \
    --query 'imageDetails[0].imageTags' --output text 2>/dev/null || true); do
    case $tag in *-"$2") printf '%s\n' "$tag"; return 0 ;; esac
  done
  echo none
}

# Troca só os parâmetros dados de uma stack, sobre o template já implantado; os outros ficam como
# estão (UsePreviousValue). Mostra o change set e pede confirmação como o deploy_stack.
update_parameters() { # <stack> <setor-para-tags> <Chave=Valor>...
  local stack=$1 sector=$2 key pair changed keys
  shift 2
  local -a stack_params=()
  # Sem a lista completa, o change set aplicaria o valor PADRÃO a todo parâmetro que faltasse (por
  # exemplo AlertEmail vazio): uma leitura que falha ou volta vazia para tudo.
  keys=$(aws_cb cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].Parameters[].ParameterKey' --output text) ||
    die "não consegui ler os parâmetros de $stack."
  [ -n "$keys" ] && [ "$keys" != None ] || die "a leitura dos parâmetros de $stack voltou vazia: recusado, para não aplicar os valores padrão."
  for key in $keys; do
    changed=0
    for pair in "$@"; do [ "${pair%%=*}" != "$key" ] || changed=1; done
    [ "$changed" = 1 ] || stack_params+=("ParameterKey=$key,UsePreviousValue=true")
  done
  for pair in "$@"; do stack_params+=("ParameterKey=${pair%%=*},ParameterValue=${pair#*=}"); done
  deploy_stack "$stack" @previous "$sector" "${stack_params[@]}"
}

# Liga a proteção contra término da VM de um setor e grava a tag da imagem em uso, sem mexer em mais nada.
protect_sector() { # <setor> <tag da imagem em uso ou none>
  update_parameters "bb-srv-$1-compute" "$1" TerminationProtection=true "ImageTag=$2"
}

# Budget do projeto = soma dos budgets dos setores + 30 (o fixo compartilhado, ~23,85, com folga).
# Roda no fim do add-sector.sh e do remove-sector.sh; uma falha só avisa (o setor já está pronto).
# Qualquer leitura que falhe faz a soma falhar (uma soma parcial baixaria o budget).
project_budget_target() {
  local total=30 stacks stack value
  stacks=$(aws_cb cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
    --query "StackSummaries[?starts_with(StackName,'bb-srv-') && ends_with(StackName,'-compute')].StackName" --output text) || return 1
  for stack in $stacks; do
    value=$(stack_parameter "$stack" BudgetUsd) || return 1
    [[ $value =~ ^[0-9]+$ ]] || return 1
    total=$((total + value))
  done
  printf '%s\n' "$total"
}

sync_project_budget() {
  local target current rc
  target=$(project_budget_target) || { warn "não consegui somar os budgets dos setores: o budget do projeto ficou como estava (scripts/deploy-base.sh --project-budget-usd N)."; return 0; }
  current=$(stack_parameter bb-srv-base ProjectBudgetUsd) || { warn "não consegui ler o budget do projeto: ficou como estava."; return 0; }
  if [ "$target" = "$current" ]; then
    say "   budget do projeto já está em US\$ $target."
    return 0
  fi
  say "== budget do projeto: US\$ $current -> $target (soma dos budgets dos setores + 30)"
  # Num subshell do lado esquerdo de `||` o set -e fica desligado (até o die dos comandos sem checagem
  # deixaria de valer): o subshell roda como comando simples, com set -e, e o retorno é lido depois.
  set +e
  (
    set -e
    update_parameters bb-srv-base shared "ProjectBudgetUsd=$target"
  )
  rc=$?
  set -e
  [ "$rc" = 0 ] || warn "não atualizei o budget do projeto. Faça depois: scripts/deploy-base.sh --project-budget-usd $target"
}

# Roda um documento SSM numa instância e espera o fim. Mostra a saída (as últimas 60 linhas) e a
# deixa inteira em SSM_OUTPUT (primeiros 24.000 caracteres, limite da API). Volta 0 só com Success.
SSM_OUTPUT=''
ssm_run() { # <instância> <documento> <parâmetros-json> <timeout-s> [log group]
  local instance=$1 document=$2 parameters=$3 timeout=$4 group=${5:-} id status waited=0
  local -a args=(--instance-ids "$instance" --document-name "$document" --parameters "$parameters"
    --timeout-seconds 600 --query Command.CommandId --output text)
  if [ -n "$group" ]; then
    args+=(--cloud-watch-output-config "CloudWatchOutputEnabled=true,CloudWatchLogGroupName=$group")
  fi
  # Chamado dentro de `||`/`if` (set -e desligado): sem isto, um send-command recusado esperaria o
  # timeout inteiro consultando um comando vazio.
  id=$(aws_cb ssm send-command "${args[@]}") || { warn "send-command de $document em $instance falhou."; return 1; }
  [[ $id =~ ^[0-9a-f-]{36}$ ]] || { warn "id de comando inválido de $document: $id"; return 1; }
  say "   $document em $instance: comando $id"
  while :; do
    sleep 10
    waited=$((waited + 10))
    status=$(aws_cb ssm get-command-invocation --command-id "$id" --instance-id "$instance" --query Status --output text 2>/dev/null || echo Pending)
    case $status in
      Pending | InProgress | Delayed) ;;
      *) break ;;
    esac
    [ "$waited" -lt "$timeout" ] || {
      warn "tempo esgotado esperando $document ($id)."
      return 1
    }
  done
  SSM_OUTPUT=$(aws_cb ssm get-command-invocation --command-id "$id" --instance-id "$instance" \
    --query '[StandardOutputContent,StandardErrorContent]' --output text)
  printf '%s\n' "$SSM_OUTPUT" | tail -n 60
  [ "$status" = Success ] || {
    warn "$document terminou com $status."
    return 1
  }
}

wait_ssm_online() { # <instância> <timeout-s>
  local instance=$1 timeout=$2 waited=0 ping
  while :; do
    ping=$(aws_cb ssm describe-instance-information --filters "Key=InstanceIds,Values=$instance" \
      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo None)
    [ "$ping" = Online ] && return 0
    [ "$waited" -lt "$timeout" ] || return 1
    sleep 15
    waited=$((waited + 15))
  done
}

# vCPU on-demand das famílias padrão (A, C, D, H, I, M, R, T, Z) das instâncias da região que os
# filtros pegam.
vcpus_of() { # <filtros do describe-instances>...
  aws_cb ec2 describe-instances --filters "$@" \
    --query 'Reservations[].Instances[].[InstanceType,CpuOptions.CoreCount,CpuOptions.ThreadsPerCore]' --output text |
    awk '$1 ~ /^(a|c|d|h|i|m|r|t|z)[0-9a-z-]*\./ && $1 !~ /^(inf|hpc|dl|trn)/ { s += $2 * $3 } END { print s + 0 }'
}

# Conta as VMs ligadas da conta e também os setores PARADOS: um setor em horário comercial fica parado
# das 20:00 às 08:00 e no fim de semana, e às 08:00 todos ligam juntos (um StartInstances sem cota
# falha, ou come a reserva do EKS/Karpenter).
check_vcpu_quota() { # <vcpus-novos>
  local need=$1 quota used parked free
  quota=$(aws_cb service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --query Quota.Value --output text)
  quota=${quota%.*}
  used=$(vcpus_of Name=instance-state-name,Values=pending,running)
  parked=$(vcpus_of Name=instance-state-name,Values=stopped,stopping "Name=tag:Project,Values=$BB_PROJECT")
  free=$((quota - used - parked - need))
  say "   cota de vCPU on-demand: $quota; em uso: $used; setores parados (voltam a ligar): $parked; depois desta operação: $free livres (reserva: $BB_VCPU_RESERVE)."
  if [ "$free" -lt "$BB_VCPU_RESERVE" ] && [ "${BB_SRV_IGNORE_QUOTA:-0}" != 1 ]; then
    die "a folga de vCPU ficaria abaixo de $BB_VCPU_RESERVE (o EKS/Karpenter divide a cota L-1216C47A). Peça aumento da cota (README, ação do dono) ou use BB_SRV_IGNORE_QUOTA=1 conscientemente."
  fi
}

# Elastic IPs da região: a cota L-0263D0A3 é dividida com o resto da conta (o NAT da VPC 10.50.0.0/17
# usa um). Sempre sobra pelo menos 1 para a conta (BB_SRV_EIP_RESERVE).
check_eip_quota() { # <EIPs novos>
  local need=$1 quota used free reserve=${BB_SRV_EIP_RESERVE:-1}
  quota=$(aws_cb service-quotas get-service-quota --service-code ec2 --quota-code L-0263D0A3 --query Quota.Value --output text)
  quota=${quota%.*}
  used=$(aws_cb ec2 describe-addresses --query 'length(Addresses)' --output text)
  free=$((quota - used - need))
  say "   cota de Elastic IPs: $quota; em uso: $used; depois desta operação: $free livres (reserva: $reserve)."
  if [ "$free" -lt "$reserve" ] && [ "${BB_SRV_IGNORE_QUOTA:-0}" != 1 ]; then
    die "a cota de Elastic IPs (L-0263D0A3) ficaria abaixo da reserva de $reserve, que fica para a conta (ex.: recriar o NAT da VPC existente). Peça aumento da cota, use o setor sem --static-ip ou BB_SRV_IGNORE_QUOTA=1 conscientemente."
  fi
}

ubuntu_ami() { # <arm64|amd64>
  aws_cb ssm get-parameters --names "/aws/service/canonical/ubuntu/server/24.04/stable/current/$1/hvm/ebs-gp3/ami-id" \
    --query 'Parameters[0].Value' --output text
}

build_bucket() { stack_output bb-srv-base BuildBucketName; }
repo_uri() { stack_output bb-srv-base RepositoryUri; }

# A imagem que o bb-srv-Install diz rodar, lida da saída do SSM. Essa saída mistura passos que não
# são de confiança, então "a última linha ganha" deixaria uma linha forjada decidir o que fica no
# parâmetro do setor. Vale uma única linha "BB_IMAGE <repositório>@sha256:<64 hex>" e só do nosso
# repositório ECR ($2): duas linhas, outro registro ou outro formato recusam. Uso: <saída> <repo>
parse_running_image() {
  local output=$1 repo=$2 lines count
  lines=$(sed -n 's/^BB_IMAGE //p' <<<"$output")
  count=$(grep -c . <<<"$lines" || true)
  if [ "$count" != 1 ]; then
    printf 'esperava uma única linha BB_IMAGE na saída do bb-srv-Install e achei %s\n' "$count" >&2
    return 1
  fi
  if [[ $lines != "$repo"@sha256:* ]]; then
    printf 'a linha BB_IMAGE não é do repositório ECR do projeto\n' >&2
    return 1
  fi
  if ! [[ $lines =~ ^[A-Za-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]]; then
    printf 'a linha BB_IMAGE não tem um digest sha256 válido\n' >&2
    return 1
  fi
  printf '%s\n' "$lines"
}

# Lê o relatório do builder (reports/<tag>.json) e confere o que não depende da aprovação: a tag
# (<versão>-<sha7>-<arch>), a arquitetura, a marca de rejeição, o teste de fumaça, o bundle -ops, o
# commit (40 hex, o sha7 da tag, existe no fork) e a versão (a do package.json desse commit e a da
# tag), e que as duas tags apontam no ECR para os digests do relatório. Exporta IMAGE_TAG,
# IMAGE_DIGEST, OPS_DIGEST, IMAGE_VERSION, IMAGE_COMMIT, IMAGE_BUILT_AT e IMAGE_SOURCE_SHA256.
verify_report() { # <tag> <arm64|amd64>
  local tag=$1 arch=$2 bucket report prefix ops_tag ecr_image ecr_ops fork_version
  [[ $tag =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{7}-(arm64|amd64)$ ]] || die "tag inválida: $tag (esperava <versão>-<sha7>-<arch>)."
  bucket=$(build_bucket)
  report=$(aws_cb s3 cp "s3://$bucket/reports/$tag.json" - 2>/dev/null) || die "não há relatório s3://$bucket/reports/$tag.json: só imagens do builder são aceitas."
  jq -e 'type == "object"' <<<"$report" >/dev/null 2>&1 || die "o relatório reports/$tag.json não é um objeto JSON. Recusado."
  [ "$(jq -r '.tag' <<<"$report")" = "$tag" ] || die "o relatório reports/$tag.json diz outra tag ($(jq -r '.tag' <<<"$report")). Recusado."
  [ "$(jq -r '.arch' <<<"$report")" = "$arch" ] || die "a imagem $tag não é $arch."
  [ "$(jq -r '.rejected // false' <<<"$report")" = false ] || die "a imagem $tag está marcada como rejeitada no relatório."
  [ "$(jq -r '.smokeTest' <<<"$report")" = passed ] || die "a imagem $tag não passou no teste de fumaça."
  prefix=${tag%-"$arch"}
  ops_tag=$(jq -r '.opsTag' <<<"$report")
  [ "$ops_tag" = "$prefix-ops" ] || die "o relatório $tag aponta para o bundle $ops_tag, que não é $prefix-ops. Recusado."
  IMAGE_TAG=$tag
  IMAGE_DIGEST=$(jq -r '.imageDigest' <<<"$report")
  OPS_DIGEST=$(jq -r '.opsDigest' <<<"$report")
  IMAGE_VERSION=$(jq -r '.version' <<<"$report")
  IMAGE_COMMIT=$(jq -r '.commit' <<<"$report")
  IMAGE_BUILT_AT=$(jq -r '.builtAt // "?"' <<<"$report")
  IMAGE_SOURCE_SHA256=$(jq -r '.sourceSha256 // ""' <<<"$report")
  [[ $IMAGE_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] && [[ $OPS_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "digests inválidos no relatório $tag."
  # O relatório descreve o commit que a tag nomeia, e esse commit existe no fork com essa versão.
  [ "$IMAGE_VERSION" = "${prefix%-*}" ] || die "o relatório $tag diz a versão $IMAGE_VERSION, que não é a da tag (${prefix%-*}). Recusado."
  [[ $IMAGE_COMMIT =~ ^[0-9a-f]{40}$ ]] && [ "${IMAGE_COMMIT:0:7}" = "${prefix##*-}" ] ||
    die "o relatório $tag aponta para o commit $IMAGE_COMMIT, que não é o da tag (${prefix##*-}). Recusado."
  git -C "$BB_FORK" rev-parse --git-dir >/dev/null 2>&1 || die "o fork não está em $BB_FORK (defina BB_SRV_FORK): ele confere o commit do relatório."
  git -C "$BB_FORK" cat-file -e "$IMAGE_COMMIT^{commit}" 2>/dev/null ||
    die "o commit $IMAGE_COMMIT do relatório $tag não existe no fork $BB_FORK (falta um git fetch?). Recusado."
  fork_version=$(git -C "$BB_FORK" show "$IMAGE_COMMIT:package.json" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
  [ "$fork_version" = "$IMAGE_VERSION" ] || die "o package.json do commit $IMAGE_COMMIT tem a versão ${fork_version:-nenhuma}, não $IMAGE_VERSION. Recusado."
  ecr_image=$(aws_cb ecr describe-images --repository-name "$BB_REPO_NAME" --image-ids "imageTag=$tag" \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true)
  ecr_ops=$(aws_cb ecr describe-images --repository-name "$BB_REPO_NAME" --image-ids "imageTag=$ops_tag" \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true)
  if [ "$ecr_image" != "$IMAGE_DIGEST" ] || [ "$ecr_ops" != "$OPS_DIGEST" ]; then
    die "o relatório $tag não bate com o ECR (tag $tag -> ${ecr_image:-ausente}, relatório $IMAGE_DIGEST; tag $ops_tag -> ${ecr_ops:-ausente}, relatório $OPS_DIGEST): relatório adulterado, errado ou imagem expirada. Recusado."
  fi
  export IMAGE_TAG IMAGE_DIGEST OPS_DIGEST IMAGE_VERSION IMAGE_COMMIT IMAGE_BUILT_AT IMAGE_SOURCE_SHA256
}

# A imagem que um setor pode rodar. Sem tag, usa o relatório mais novo da arquitetura (mostra commit e
# data e pede confirmação). Além do verify_report, exige a APROVAÇÃO gravada pelo Mac do operador
# (/bb-srv/images/<tag> = "<digest da imagem> <digest do -ops>", fora do alcance do builder) igual ao
# relatório e ao ECR, e o scan do ECR terminado (COMPLETE) e sem CRITICAL na base (DESIGN 7.4).
# Rejeitar uma imagem = apagar a aprovação (scripts/build-image.sh reject <tag>).
resolve_image() { # <tag ou vazio> <arm64|amd64>
  local tag=$1 arch=$2 bucket key newest=0 anchor scan critical
  if [ -z "$tag" ]; then
    bucket=$(build_bucket)
    key=$(aws_cb s3api list-objects-v2 --bucket "$bucket" --prefix reports/ \
      --query "sort_by(Contents[?ends_with(Key,'-$arch.json')], &LastModified)[-1].Key" --output text 2>/dev/null || true)
    [ -n "$key" ] && [ "$key" != None ] || die "não há relatório de build para $arch em s3://$bucket/reports/. Rode scripts/build-image.sh launch <commit> antes."
    tag=$(basename "$key" .json)
    newest=1
  fi
  verify_report "$tag" "$arch"
  anchor=$(aws_cb ssm get-parameter --name "/bb-srv/images/$tag" --query Parameter.Value --output text 2>/dev/null || true)
  [ -n "$anchor" ] && [ "$anchor" != None ] ||
    die "a imagem $tag não está aprovada (falta /bb-srv/images/$tag): foi rejeitada, ou o launch não chegou ao fim. Aprovar: scripts/build-image.sh approve $tag."
  [ "$anchor" = "$IMAGE_DIGEST $OPS_DIGEST" ] ||
    die "o relatório $tag não bate com a aprovação /bb-srv/images/$tag ($anchor): relatório reescrito ou tag publicada de novo. Recusado."
  # Fail closed: scan em andamento, falho, sem suporte ou ilegível não conta como limpo.
  read -r scan critical <<<"$(aws_cb ecr describe-image-scan-findings --repository-name "$BB_REPO_NAME" --image-id "imageDigest=$IMAGE_DIGEST" \
    --query '[imageScanStatus.status, imageScanFindings.findingSeverityCounts.CRITICAL]' --output text 2>/dev/null || echo 'ilegível None')"
  if [ "$scan" != COMPLETE ]; then
    [ "${BB_SRV_ACCEPT_UNSCANNED:-0}" = 1 ] ||
      die "o scan do ECR da imagem $tag está em ${scan:-ilegível} (não COMPLETE). Espere o scan terminar, ou use BB_SRV_ACCEPT_UNSCANNED=1 só com a revisão registrada."
    warn "a imagem $tag entra sem scan concluído ($scan), só porque BB_SRV_ACCEPT_UNSCANNED=1."
  elif [ "$critical" != None ] && [ "$critical" != 0 ] && [ "${BB_SRV_ACCEPT_CRITICAL:-0}" != 1 ]; then
    die "o scan do ECR achou $critical vulnerabilidade(s) CRITICAL na base da imagem $tag. Revise e use BB_SRV_ACCEPT_CRITICAL=1 só com a revisão registrada."
  fi
  if [ "$newest" = 1 ]; then
    say "   imagem mais nova: $tag, commit $IMAGE_COMMIT, construída em $IMAGE_BUILT_AT"
    confirm "Usar a imagem $tag (sem --image-tag, é a do relatório mais novo)? Digite 'sim':" sim
  fi
  say "   imagem $IMAGE_TAG (versão $IMAGE_VERSION) $IMAGE_DIGEST"
}

# sha256 do `git archive` (tar.gz) de um commit do fork: o mesmo arquivo que o upload_source envia.
source_hash() { # <commit>
  local commit=$1 sha work hash
  git -C "$BB_FORK" rev-parse --git-dir >/dev/null 2>&1 || die "o fork não está em $BB_FORK (defina BB_SRV_FORK)."
  sha=$(git -C "$BB_FORK" rev-parse --verify "$commit^{commit}" 2>/dev/null) || die "commit desconhecido no fork: $commit"
  work=$(mktemp -d "${TMPDIR:-/tmp}/bb-srv-src.XXXXXX")
  # De um commit, nunca da árvore de trabalho (que pode estar no meio de um merge).
  git -C "$BB_FORK" archive --format=tar.gz -o "$work/$sha.tar.gz" "$sha"
  hash=$(shasum -a 256 "$work/$sha.tar.gz" | cut -d ' ' -f 1)
  rm -f "$work/$sha.tar.gz"
  rmdir "$work"
  printf '%s\n' "$hash"
}

# Envia o código de um commit do fork para s3://<build>/src/<sha>.tar.gz com o sha256 na metadata.
# O hash é sempre o do arquivo gerado aqui, de um commit; quem extrai (builder, Signal) confere com ele.
# Reaproveita o objeto só quando a metadata bate; senão envia de novo (o bucket tem versionamento).
upload_source() { # <commit> -> imprime "<sha do commit> <sha256 do tarball>"
  local commit=$1 sha bucket work hash remote
  git -C "$BB_FORK" rev-parse --git-dir >/dev/null 2>&1 || die "o fork não está em $BB_FORK (defina BB_SRV_FORK)."
  sha=$(git -C "$BB_FORK" rev-parse --verify "$commit^{commit}" 2>/dev/null) || die "commit desconhecido no fork: $commit"
  bucket=$(build_bucket)
  work=$(mktemp -d "${TMPDIR:-/tmp}/bb-srv-src.XXXXXX")
  # De um commit, nunca da árvore de trabalho (que pode estar no meio de um merge).
  git -C "$BB_FORK" archive --format=tar.gz -o "$work/$sha.tar.gz" "$sha"
  hash=$(shasum -a 256 "$work/$sha.tar.gz" | cut -d ' ' -f 1)
  remote=$(aws_cb s3api head-object --bucket "$bucket" --key "src/$sha.tar.gz" --query 'Metadata.sha256' --output text 2>/dev/null || true)
  if [ "$remote" != "$hash" ]; then
    case $remote in '' | None) ;; *) warn "s3://$bucket/src/$sha.tar.gz tinha outro sha256 ($remote); enviando de novo." ;; esac
    aws_cb s3 cp --only-show-errors --sse AES256 --metadata "sha256=$hash" "$work/$sha.tar.gz" "s3://$bucket/src/$sha.tar.gz" >&2
  fi
  rm -f "$work/$sha.tar.gz"
  rmdir "$work"
  printf '%s %s\n' "$sha" "$hash"
}

sector_instance() { # <setor>
  local id
  id=$(stack_output "bb-srv-$1-compute" InstanceId 2>/dev/null || true)
  [ -n "$id" ] && [ "$id" != None ] || die "o setor $1 não tem instância (stack bb-srv-$1-compute)."
  printf '%s\n' "$id"
}

sector_volume() { # <setor>
  local id
  id=$(stack_output "bb-srv-$1-data" VolumeId 2>/dev/null || true)
  [ -n "$id" ] && [ "$id" != None ] || die "o setor $1 não tem volume de dados (stack bb-srv-$1-data)."
  printf '%s\n' "$id"
}

# Snapshot do volume de dados com as tags do setor. Espera ficar completo. Imprime o id.
snapshot_volume() { # <setor> <volume> <propósito> <dias-de-retenção>
  local sector=$1 volume=$2 purpose=$3 days=$4 id state waited=0
  id=$(aws_cb ec2 create-snapshot --volume-id "$volume" --description "bb-srv $sector $purpose" \
    --tag-specifications "ResourceType=snapshot,Tags=[{Key=Name,Value=bb-srv-$sector-$purpose},{Key=Sector,Value=$sector},{Key=CostCenter,Value=$sector},{Key=Project,Value=$BB_PROJECT},{Key=Owner,Value=$BB_OWNER},{Key=Purpose,Value=$purpose},{Key=ExpiresAt,Value=$(date_plus_days "$days")}]" \
    --query SnapshotId --output text)
  say "   snapshot $id ($purpose) iniciado" >&2
  while :; do
    state=$(aws_cb ec2 describe-snapshots --snapshot-ids "$id" --query 'Snapshots[0].State' --output text)
    case $state in
      completed) break ;;
      error) die "o snapshot $id falhou." ;;
    esac
    [ "$waited" -lt 7200 ] || die "o snapshot $id não terminou em 2 h."
    sleep 20
    waited=$((waited + 20))
  done
  printf '%s\n' "$id"
}

# ---------------------------------------------------------------- proxy de saída (README, seção 16)
BB_PROXY_PARAMETER=/bb-srv/proxy/egress

# Tipo do parâmetro do proxy residencial (SecureString, None quando não existe, "erro" quando a leitura
# falha). Só describe-parameters: o VALOR nunca é lido no Mac.
proxy_parameter_type() {
  aws_cb ssm describe-parameters --parameter-filters "Key=Name,Option=Equals,Values=$BB_PROXY_PARAMETER" \
    --query 'Parameters[0].Type' --output text 2>/dev/null || echo erro
}

# Todo setor novo sai pelo proxy: sem o parâmetro (ou com ele em texto puro), nada é criado.
require_proxy_parameter() {
  local type
  type=$(proxy_parameter_type)
  case $type in
    SecureString) say "   proxy de saída: $BB_PROXY_PARAMETER existe (SecureString; o valor não é lido aqui)" ;;
    None | '') die "falta o parâmetro $BB_PROXY_PARAMETER (proxy residencial de saída, obrigatório para todo setor). O dono grava host:porta:usuário:senha numa linha, como SecureString, pela entrada padrão, sem a senha na linha de comando nem no histórico do shell: README, seção 16, 'Trocar a senha', passo 1. Sem proxy, só com --egress-direct, por decisão do dono." ;;
    erro) die "não consegui conferir $BB_PROXY_PARAMETER (ssm describe-parameters falhou): sem essa conferência nenhum setor é criado." ;;
    *) die "$BB_PROXY_PARAMETER existe como $type, não SecureString: a senha do proxy estaria em texto puro. O dono grava de novo como SecureString (README, seção 16)." ;;
  esac
}

# Lê as linhas BB_PROXY_* do bb-srv-Status e diz em português o que o contêiner vê. Só valem as linhas
# entre o ÚLTIMO "egress proxy:" e a linha final BB_PROXY_END, que o root imprime: o que vem do contêiner e
# do app sai antes, atrás de "  | " e com limite de tamanho, e não forja um veredito. Sem a linha final, a
# saída veio cortada (o SSM guarda só os primeiros 24.000 caracteres) e nada é concluído. Mesmo ali, só
# valores no formato esperado são mostrados.
# Uso: <saída> <setor> <EgressProxy> [instância]
proxy_verdict() {
  local section state out sector=$2 egress=$3 instance=${4:-<instância>} exit_line ip country repair
  # Primeira linha: none (sem o marcador), cut (sem a linha final, ou vazia) ou ok; depois, a parte do root.
  # O AWS CLI (--output text) põe a saída de erro depois de uma tabulação, que pode colar na linha final.
  section=$(awk '
    $0 == "egress proxy:" { buf = ""; on = 1; done = 0; next }
    on && !done && ($0 == "BB_PROXY_END" || index($0, "BB_PROXY_END\t") == 1) { done = 1 }
    on && !done { buf = buf $0 "\n" }
    END { printf "%s\n%s", !on ? "none" : (!done || buf == "" ? "cut" : "ok"), buf }' <<<"$1")
  state=$(head -n 1 <<<"$section")
  out=$(sed 1d <<<"$section")
  repair="rode o reparo (README, seção 16, 'Reparar um setor instalado'): aws --profile $BB_PROFILE --region $BB_REGION ssm send-command --instance-ids $instance --document-name bb-srv-ProxySetup; depois, scripts/status.sh $sector --deep"
  if [ "$egress" = direct ]; then
    say "      proxy de saída: DESLIGADO neste setor (EgressProxy=direct, decisão do dono); a saída é o IP da AWS."
    return 0
  fi
  if [ "$state" = none ]; then
    say "      PROXY NÃO CONFERIDO: a saída do bb-srv-Status não tem a parte 'egress proxy:' (documento bb-srv-Status antigo? scripts/deploy-base.sh)."
    return 0
  fi
  if [ "$state" != ok ]; then
    say "      PROXY NÃO CONFERIDO: a parte do root na saída do bb-srv-Status veio sem a linha final BB_PROXY_END (cortada: o SSM guarda só os primeiros 24.000 caracteres; ou documento bb-srv-Status antigo: scripts/deploy-base.sh). Repita o status --deep; se persistir, na sessão bb-srv-$sector-Shell: sudo /usr/local/sbin/bb-srv-proxy check-container."
    return 0
  fi
  if grep -qx 'BB_PROXY_MODE not-installed' <<<"$out"; then
    say "      PROXY AUSENTE: o host não tem o proxy de saída instalado. Se o setor ainda não terminou a instalação: scripts/add-sector.sh $sector --resume. Se já está instalado e protegido, $repair."
    return 0
  fi
  if grep -qx 'BB_PROXY_MODE direct' <<<"$out"; then
    say "      PROXY AUSENTE: o host está em saída direta, mas a stack pede o proxy (EgressProxy=required). Troque a VM: README, seção 11."
    return 0
  fi
  if grep -qx 'BB_PROXY_CONTAINED yes' <<<"$out"; then
    say "      CONTÊINER PARADO POR VAZAMENTO: uma conferência achou saída fora do proxy e parou o contêiner (marca /var/lib/bb-srv/egress-open; ele não sobe no boot). Corrija a causa (linhas BB_PROXY_HEALTH acima) e $repair."
  fi
  if grep -qx 'BB_PROXY_CONTAINER down' <<<"$out"; then
    say "      proxy de saída: o contêiner não está rodando; nada a conferir de dentro dele."
    return 0
  fi
  if grep -qx 'BB_PROXY_CONTAINER unknown' <<<"$out"; then
    say "      CONTÊINER NÃO CONFERIDO: o docker do host não respondeu sobre o contêiner (docker inspect), então nada foi testado; a saúde grava fail container-unknown. Repita o status --deep; se persistir, sessão bb-srv-$sector-Shell: sudo systemctl status docker."
    return 0
  fi
  grep -qx 'BB_PROXY_ENV ok' <<<"$out" ||
    say "      PROXY AUSENTE NO CONTÊINER: ele não tem HTTPS_PROXY/NODE_USE_ENV_PROXY do proxy.env (compose.yaml sem o env_file, ou contêiner criado antes dele). Nada sai direto (falha fechada), mas o servidor fica sem internet: $repair."
  exit_line=$(grep -E '^BB_PROXY_EXIT (ip=[0-9]{1,3}(\.[0-9]{1,3}){3} )?country=[A-Z]{2}$' <<<"$out" | tail -n 1 || true)
  if [ -n "$exit_line" ]; then
    country=${exit_line##*country=}
    ip=$(sed -n 's/^BB_PROXY_EXIT ip=\([0-9.]*\) .*/\1/p' <<<"$exit_line")
    if [ "$country" = BR ]; then
      say "      saída vista de dentro do contêiner: IP ${ip:-?}, país $country (proxy residencial ok)"
    else
      say "      PAÍS ERRADO: a saída do contêiner é ${ip:-?} ($country), não BR. Confira /bb-srv/proxy/egress com o dono (README, seção 16); o alarme bb-srv-$sector-egress-proxy fica em ALARM."
    fi
  else
    say "      PROXY SEM RESPOSTA: o contêiner não saiu pelo proxy (encaminhador parado, senha errada ou proxy fora do ar). Veja as linhas BB_PROXY_HEALTH acima e o README, seção 16."
  fi
  if grep -qx 'BB_PROXY_DIRECT OPEN' <<<"$out"; then
    say "      SAÍDA DIRETA ABERTA: o contêiner alcança a internet sem o proxy (o firewall de falha fechada não faz efeito). A saúde do host para o contêiner na próxima rodada (até 4 min). Investigue o iptables e depois $repair."
  elif grep -qx 'BB_PROXY_DIRECT blocked' <<<"$out"; then
    say "      saída direta bloqueada: sem o proxy nada sai (falha fechada)"
  else
    say "      SAÍDA DIRETA NÃO CONFERIDA: o teste a partir da rede do contêiner não deu resposta clara (nsenter, setpriv ou curl do host). Repita; se persistir, sessão bb-srv-$sector-Shell e README, seção 16."
  fi
  if grep -qx 'BB_PROXY_DNS_FILTER OPEN' <<<"$out"; then
    say "      DNS ABERTO: o contêiner resolve nomes fora de signal./turn. (consultas saem pelo resolvedor da VPC; túnel DNS possível). A saúde do host para o contêiner na próxima rodada. Confira o bb-srv-container-dns e o dns do /etc/docker/daemon.json; depois $repair."
  elif grep -qx 'BB_PROXY_DNS_FILTER ok' <<<"$out"; then
    say "      DNS do contêiner restrito: só signal./turn. da zona"
  else
    say "      DNS DO CONTÊINER NÃO CONFERIDO: o teste do filtro de DNS (o dig do host, de dentro da rede do contêiner) não deu resposta clara, ou a linha BB_PROXY_DNS_FILTER falta (veja acima); a saúde grava fail dns-unknown. Repita; se persistir, sessão bb-srv-$sector-Shell: sudo systemctl status bb-srv-container-dns, e README, seção 16."
  fi
  if grep -qx 'BB_PROXY_DNS fail' <<<"$out"; then
    say "      DNS DO CONTÊINER QUEBRADO: ele não resolve signal.<zona> (o host resolve) e ninguém conecta. Sessão bb-srv-$sector-Shell: sudo systemctl status bb-srv-container-dns; depois $repair."
  fi
  if grep -qx 'BB_PROXY_SIGNAL ok' <<<"$out"; then
    say "      Signal/TURN alcançado de dentro do contêiner"
  elif grep -qx 'BB_PROXY_SIGNAL fail' <<<"$out"; then
    say "      SIGNAL BLOQUEADO: o host alcança o Signal e o contêiner não (regra RETURN da BB-SRV-EGRESS): ninguém conecta. Rode o bb-srv-ProxyReload (README, seção 16)."
  elif grep -qx 'BB_PROXY_SIGNAL unreachable' <<<"$out"; then
    say "      Signal fora de alcance também do host: portas ainda fechadas (scripts/deploy-signal.sh --approve-ingress) ou Signal fora do ar."
  elif grep -qx 'BB_PROXY_SIGNAL skipped' <<<"$out"; then
    say "      Signal/TURN não testado: o host ainda não resolve signal.<zona> (stack bb-srv-signal ainda não criada?)."
  else
    say "      SIGNAL NÃO CONFERIDO: a linha BB_PROXY_SIGNAL falta (a conferência do contêiner não terminou?). Repita o status --deep."
  fi
}
