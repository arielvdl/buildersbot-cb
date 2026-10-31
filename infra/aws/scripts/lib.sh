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

# Tamanho -> "tipo vcpus memória-do-container cpus-do-container tmpfs arquitetura" (DESIGN 2.6).
size_info() {
  case $1 in
    medium) echo "t4g.medium 2 3000m 2 1g arm64" ;;
    large) echo "t4g.large 2 6500m 2 3g arm64" ;;
    xlarge) echo "t4g.xlarge 4 14g 4 4g arm64" ;;
    steady) echo "m7g.large 2 6500m 2 3g arm64" ;;
    x86) echo "t3a.large 2 6500m 2 3g amd64" ;;
    *) die "tamanho inválido: '$1'. Use medium, large, xlarge, steady ou x86." ;;
  esac
}

date_plus_days() {
  date -u -v+"$1"d +%F 2>/dev/null || date -u -d "+$1 days" +%F
}

confirm() { # <pergunta> <resposta esperada>
  if [ "${BB_SRV_YES:-0}" = 1 ]; then return 0; fi
  [ -t 0 ] || die "a confirmação precisa de um terminal (ou use --yes)."
  local answer
  printf '%s ' "$1" >&2
  read -r answer
  [ "$answer" = "$2" ] || die "cancelado."
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

# Cria um change set, mostra, recusa substituição ou remoção de instância, volume ou anexo numa
# atualização (DESIGN R2-1), pede confirmação e executa. Parâmetros: ParameterKey=K,ParameterValue=V
# ou ParameterKey=K,UsePreviousValue=true. Template @previous = o template já implantado (só troca
# parâmetros; o arquivo local não entra).
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
    die "o change set de $stack falhou: $reason"
  fi
  aws_cb cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" \
    --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' --output table
  if [ "$type" = UPDATE ]; then
    risky=$(aws_cb cloudformation describe-change-set --stack-name "$stack" --change-set-name "$name" --output text \
      --query "Changes[?(ResourceChange.ResourceType=='AWS::EC2::Instance' || ResourceChange.ResourceType=='AWS::EC2::Volume' || ResourceChange.ResourceType=='AWS::EC2::VolumeAttachment') && (ResourceChange.Action=='Remove' || (ResourceChange.Action=='Modify' && ResourceChange.Replacement!='False'))].ResourceChange.LogicalResourceId")
    if [ -n "$risky" ] && [ "$risky" != None ]; then
      aws_cb cloudformation delete-change-set --stack-name "$stack" --change-set-name "$name" >/dev/null || true
      die "recusado: este change set substitui ou remove $risky. Use o fluxo de troca de VM do README (seção Recuperação)."
    fi
  fi
  confirm "Executar o change set $name em $stack? Digite 'sim':" sim
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

# Liga a proteção contra término da VM de um setor e grava a tag da imagem em uso, sem mexer em mais
# nada: change set sobre o template já implantado, com os outros parâmetros como estão.
protect_sector() { # <setor> <tag da imagem em uso ou none>
  local stack="bb-srv-$1-compute" key
  local -a stack_params=()
  for key in $(aws_cb cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].Parameters[].ParameterKey' --output text); do
    case $key in TerminationProtection | ImageTag) ;; *) stack_params+=("ParameterKey=$key,UsePreviousValue=true") ;; esac
  done
  stack_params+=("ParameterKey=TerminationProtection,ParameterValue=true" "ParameterKey=ImageTag,ParameterValue=$2")
  deploy_stack "$stack" @previous "$1" "${stack_params[@]}"
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
  id=$(aws_cb ssm send-command "${args[@]}")
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

# vCPU on-demand das famílias padrão (A, C, D, H, I, M, R, T, Z) em uso na conta, na região.
vcpus_in_use() {
  aws_cb ec2 describe-instances --filters Name=instance-state-name,Values=pending,running \
    --query 'Reservations[].Instances[].[InstanceType,CpuOptions.CoreCount,CpuOptions.ThreadsPerCore]' --output text |
    awk '$1 ~ /^(a|c|d|h|i|m|r|t|z)[0-9a-z-]*\./ && $1 !~ /^(inf|hpc|dl|trn)/ { s += $2 * $3 } END { print s + 0 }'
}

check_vcpu_quota() { # <vcpus-novos>
  local need=$1 quota used free
  quota=$(aws_cb service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --query Quota.Value --output text)
  quota=${quota%.*}
  used=$(vcpus_in_use)
  free=$((quota - used - need))
  say "   cota de vCPU on-demand: $quota; em uso: $used; depois desta operação: $free livres (reserva: $BB_VCPU_RESERVE)."
  if [ "$free" -lt "$BB_VCPU_RESERVE" ] && [ "${BB_SRV_IGNORE_QUOTA:-0}" != 1 ]; then
    die "a folga de vCPU ficaria abaixo de $BB_VCPU_RESERVE (o EKS/Karpenter divide a cota L-1216C47A). Peça aumento da cota (README, ação do dono) ou use BB_SRV_IGNORE_QUOTA=1 conscientemente."
  fi
}

ubuntu_ami() { # <arm64|amd64>
  aws_cb ssm get-parameters --names "/aws/service/canonical/ubuntu/server/24.04/stable/current/$1/hvm/ebs-gp3/ami-id" \
    --query 'Parameters[0].Value' --output text
}

build_bucket() { stack_output bb-srv-base BuildBucketName; }
repo_uri() { stack_output bb-srv-base RepositoryUri; }

# Lê o relatório do builder (reports/<tag>.json) e exporta IMAGE_TAG, IMAGE_DIGEST, OPS_DIGEST e
# IMAGE_VERSION. Sem tag, usa o relatório mais novo da arquitetura. Recusa imagem rejeitada, sem
# teste de fumaça, com achado CRITICAL no scan da base (DESIGN 7.4), ou cujo relatório não bate com o
# ECR: a tag (imutável; o delete é negado) tem de apontar no ECR para o digest do relatório. Assim um
# relatório reescrito não troca a imagem de uma tag já aprovada.
resolve_image() { # <tag ou vazio> <arm64|amd64>
  local tag=$1 arch=$2 bucket report key critical ops_tag ecr_image ecr_ops
  bucket=$(build_bucket)
  if [ -z "$tag" ]; then
    key=$(aws_cb s3api list-objects-v2 --bucket "$bucket" --prefix reports/ \
      --query "sort_by(Contents[?ends_with(Key,'-$arch.json')], &LastModified)[-1].Key" --output text 2>/dev/null || true)
    [ -n "$key" ] && [ "$key" != None ] || die "não há relatório de build para $arch em s3://$bucket/reports/. Rode scripts/build-image.sh launch <commit> antes."
    tag=$(basename "$key" .json)
  fi
  [[ $tag =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$ ]] || die "tag inválida: $tag"
  report=$(aws_cb s3 cp "s3://$bucket/reports/$tag.json" - 2>/dev/null) || die "não há relatório s3://$bucket/reports/$tag.json: só imagens do builder são aceitas."
  [ "$(jq -r '.tag' <<<"$report")" = "$tag" ] || die "o relatório reports/$tag.json diz outra tag ($(jq -r '.tag' <<<"$report")). Recusado."
  [ "$(jq -r '.arch' <<<"$report")" = "$arch" ] || die "a imagem $tag não é $arch."
  [ "$(jq -r '.rejected // false' <<<"$report")" = false ] || die "a imagem $tag está marcada como rejeitada no relatório."
  [ "$(jq -r '.smokeTest' <<<"$report")" = passed ] || die "a imagem $tag não passou no teste de fumaça."
  ops_tag=$(jq -r '.opsTag' <<<"$report")
  [ "$ops_tag" = "${tag%-"$arch"}-ops" ] || die "o relatório $tag aponta para o bundle $ops_tag, que não é ${tag%-"$arch"}-ops. Recusado."
  IMAGE_TAG=$tag
  IMAGE_DIGEST=$(jq -r '.imageDigest' <<<"$report")
  OPS_DIGEST=$(jq -r '.opsDigest' <<<"$report")
  IMAGE_VERSION=$(jq -r '.version' <<<"$report")
  [[ $IMAGE_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] && [[ $OPS_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "digests inválidos no relatório $tag."
  ecr_image=$(aws_cb ecr describe-images --repository-name "$BB_REPO_NAME" --image-ids "imageTag=$tag" \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true)
  ecr_ops=$(aws_cb ecr describe-images --repository-name "$BB_REPO_NAME" --image-ids "imageTag=$ops_tag" \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true)
  if [ "$ecr_image" != "$IMAGE_DIGEST" ] || [ "$ecr_ops" != "$OPS_DIGEST" ]; then
    die "o relatório $tag não bate com o ECR (tag $tag -> ${ecr_image:-ausente}, relatório $IMAGE_DIGEST; tag $ops_tag -> ${ecr_ops:-ausente}, relatório $OPS_DIGEST): relatório adulterado, errado ou imagem expirada. Recusado."
  fi
  critical=$(aws_cb ecr describe-image-scan-findings --repository-name "$BB_REPO_NAME" --image-id "imageDigest=$IMAGE_DIGEST" \
    --query 'imageScanFindings.findingSeverityCounts.CRITICAL' --output text 2>/dev/null || echo None)
  if [ "$critical" != None ] && [ "$critical" != 0 ] && [ "${BB_SRV_ACCEPT_CRITICAL:-0}" != 1 ]; then
    die "o scan do ECR achou $critical vulnerabilidade(s) CRITICAL na base da imagem $tag. Revise e use BB_SRV_ACCEPT_CRITICAL=1 só com a revisão registrada."
  fi
  export IMAGE_TAG IMAGE_DIGEST OPS_DIGEST IMAGE_VERSION
  say "   imagem $IMAGE_TAG (versão $IMAGE_VERSION) $IMAGE_DIGEST"
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
