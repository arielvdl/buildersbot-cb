#!/usr/bin/env bash
# Constrói a imagem do servidor Builders Bot (linux/arm64) a partir de um commit do fork e envia ao
# ECR bb-srv/server, com o bundle de operação (a pasta docker/ do mesmo commit). DESIGN 7.2.
#
# ONDE RODA:
#   - `launch` roda no Mac do operador (precisa de check-access ok). Ele envia o código e este script
#     ao bucket de build e liga uma EC2 t4g.xlarge efêmera (launch template bb-srv-builder: Ubuntu
#     24.04 arm64, sem porta de entrada, IMDSv2, desliga e TERMINA sozinha em até 3 h).
#   - `on-host` roda NA EC2 efêmera, como root (o user data do `launch` chama). O build precisa de
#     Linux arm64 nativo: o runtime de voz é preparado para a plataforma e a arquitetura do host
#     (scripts/prepare-voice.ts). Não rode `on-host` no Mac.
#
# CONFIANÇA: tudo o que o usuário `builder` produz ou pode alterar (node_modules, dist/, o AppImage,
# a árvore do código extraída) é não confiável. O root nunca executa nada disso. O que vai para os
# hosts de setor como root (a pasta docker/, o Dockerfile, o seccomp) e o que define as ferramentas
# (package.json, .nvmrc) saem de uma cópia que o root extrai do tarball ANTES de qualquer código do
# builder rodar, e o tarball é conferido pelo sha256 que o Mac calculou.
#
# Uso:
#   scripts/build-image.sh launch <commit> [--yes]
#   scripts/build-image.sh on-host --commit <sha> --bucket <bucket> --repo-uri <uri> --version <x.y.z>
#                                  --source-sha256 <hash do tarball>
#
# Resultado: tags <versão>-<sha7>-arm64 e <versão>-<sha7>-ops no ECR (imutáveis) e o relatório
# s3://<bucket>/reports/<versão>-<sha7>-arm64.json com os digests, que add-sector.sh exige.
set -euo pipefail

usage() { sed -n '2,26p' "$0"; }

# ------------------------------------------------------------------ launch (Mac do operador)
launch() {
  # shellcheck source=scripts/lib.sh
  source "$(dirname "$0")/lib.sh"
  local commit='' sha version short tag bucket repo script_key script_hash work template_ok instance key state waited=0
  local source source_hash
  while [ "$#" -gt 0 ]; do
    case $1 in
      --yes) BB_SRV_YES=1 ; shift ;;
      -*) die "opção desconhecida: $1" ;;
      *) commit=$1 ; shift ;;
    esac
  done
  [ -n "$commit" ] || die "informe o commit do fork."
  bb_check_access --writes
  require_stack bb-srv-base "Rode scripts/deploy-base.sh antes."
  bucket=$(build_bucket)
  repo=$(repo_uri)
  template_ok=$(aws_cb ec2 describe-launch-templates --launch-template-names bb-srv-builder --query 'length(LaunchTemplates)' --output text 2>/dev/null || echo 0)
  [ "$template_ok" = 1 ] || die "o launch template bb-srv-builder não existe."

  sha=$(git -C "$BB_FORK" rev-parse --verify "$commit^{commit}" 2>/dev/null) || die "commit desconhecido no fork $BB_FORK: $commit"
  version=$(git -C "$BB_FORK" show "$sha:package.json" | jq -r .version)
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "versão inválida no package.json de $sha: $version"
  short=${sha:0:7}
  tag="$version-$short-arm64"
  if aws_cb s3api head-object --bucket "$bucket" --key "reports/$tag.json" >/dev/null 2>&1; then
    die "já existe o relatório reports/$tag.json: esta imagem já foi construída (tags imutáveis)."
  fi
  say "== build de $tag a partir de $sha"
  check_vcpu_quota 4
  confirm "Ligar uma EC2 t4g.xlarge efêmera (~US\$ 0,13/h, termina sozinha) para construir $tag? Digite 'sim':" sim

  # O hash do tarball vai no user data: o builder confere o código antes de extrair.
  source=$(upload_source "$sha") || exit 1
  read -r _ source_hash <<<"$source"
  [[ $source_hash =~ ^[0-9a-f]{64}$ ]] || die "hash inválido do tarball do código: $source_hash"
  script_hash=$(shasum -a 256 "$0" | cut -d ' ' -f 1)
  script_key="tools/build-image-$script_hash.sh"
  aws_cb s3 cp --only-show-errors --sse AES256 "$0" "s3://$bucket/$script_key"

  work=$(mktemp -d "${TMPDIR:-/tmp}/bb-srv-build.XXXXXX")
  # O user data confere o hash do script antes de rodar e desliga a máquina no fim (terminate).
  cat >"$work/user-data.sh" <<EOF
#!/bin/bash
set -uo pipefail
exec >>/var/log/bb-srv-build.log 2>&1
shutdown -h +180
snap install aws-cli --classic
/snap/bin/aws s3 cp --only-show-errors --region $BB_REGION "s3://$bucket/$script_key" /root/build-image.sh
echo "$script_hash  /root/build-image.sh" | sha256sum -c - || { shutdown -h now; exit 1; }
bash /root/build-image.sh on-host --commit $sha --bucket $bucket --repo-uri $repo --version $version --source-sha256 $source_hash
shutdown -h now
EOF
  instance=$(aws_cb ec2 run-instances --launch-template "LaunchTemplateName=bb-srv-builder,Version=\$Latest" \
    --user-data "file://$work/user-data.sh" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=bb-srv-builder},{Key=Project,Value=$BB_PROJECT},{Key=Sector,Value=shared},{Key=CostCenter,Value=shared},{Key=Owner,Value=$BB_OWNER},{Key=ManagedBy,Value=build-image.sh},{Key=BuildTag,Value=$tag}]" \
    --query 'Instances[0].InstanceId' --output text)
  rm -f "$work/user-data.sh"
  rmdir "$work"
  say "   builder $instance ligado. Log: /var/log/bb-srv-build.log (sessão SSM) ou ec2 get-console-output."
  key="reports/$tag.json"
  while :; do
    if aws_cb s3api head-object --bucket "$bucket" --key "$key" >/dev/null 2>&1; then
      say "== relatório:"
      aws_cb s3 cp "s3://$bucket/$key" - | jq .
      break
    fi
    state=$(aws_cb ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].State.Name' --output text)
    case $state in
      shutting-down | terminated | stopped)
        aws_cb ec2 get-console-output --instance-id "$instance" --latest --query Output --output text 2>/dev/null | tail -n 40 || true
        die "o builder terminou sem relatório: o build falhou."
        ;;
    esac
    [ "$waited" -lt 12600 ] || die "sem relatório depois de 3,5 h."
    sleep 60
    waited=$((waited + 60))
  done
}

# ------------------------------------------------------------------ on-host (EC2 efêmera, root)
on_host() {
  local commit='' bucket='' repo='' version='' source_sha='' short tag ops_tag src image_dir node_version bun_version electron arch
  while [ "$#" -gt 0 ]; do
    case $1 in
      --commit) commit=${2:-} ; shift 2 ;;
      --bucket) bucket=${2:-} ; shift 2 ;;
      --repo-uri) repo=${2:-} ; shift 2 ;;
      --version) version=${2:-} ; shift 2 ;;
      --source-sha256) source_sha=${2:-} ; shift 2 ;;
      *) echo "opção desconhecida: $1" >&2 ; exit 1 ;;
    esac
  done
  [[ $commit =~ ^[0-9a-f]{40}$ ]] && [ -n "$bucket" ] && [ -n "$repo" ] && [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
    [[ $source_sha =~ ^[0-9a-f]{64}$ ]] || { echo "parâmetros inválidos" >&2; exit 1; }
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = aarch64 ] || { echo "on-host roda só em Linux arm64." >&2; exit 1; }
  [ "$(id -u)" = 0 ] || { echo "on-host roda como root." >&2; exit 1; }
  arch=arm64
  short=${commit:0:7}
  tag="$version-$short-$arch"
  ops_tag="$version-$short-ops"
  export DEBIAN_FRONTEND=noninteractive HOME=/root DOCKER_CONFIG=/root/.docker
  local aws=/snap/bin/aws
  local region=${repo#*.dkr.ecr.}
  region=${region%%.amazonaws.com*}
  echo "BB_BUILD start $tag $(date -u +%FT%TZ)"

  # O apt-daily do primeiro boot pode estar com o lock do dpkg: espera em vez de falhar.
  apt-get -o DPkg::Lock::Timeout=600 update -q
  apt-get -o DPkg::Lock::Timeout=600 install -y -q --no-install-recommends docker.io amazon-ecr-credential-helper \
    ca-certificates curl jq unzip xz-utils git build-essential python3 xvfb file
  # A cada ECR por credential helper: nenhuma senha fica em disco.
  install -d -m 0700 /root/.docker
  printf '{"credHelpers": {"%s": "ecr-login"}}\n' "${repo%%/*}" >/root/.docker/config.json

  # Usuário sem privilégio para o build, sem acesso ao IMDS (as credenciais da role são do root).
  id builder >/dev/null 2>&1 || useradd --create-home --shell /bin/bash builder
  iptables -C OUTPUT -m owner --uid-owner builder -d 169.254.169.254 -j REJECT 2>/dev/null ||
    iptables -I OUTPUT 1 -m owner --uid-owner builder -d 169.254.169.254 -j REJECT
  # O tarball fica com o root (0600) e só é usado se bater com o sha256 que o Mac calculou. O root
  # extrai dele, antes de qualquer código do builder, a cópia intocada (pristine) do que vai para os
  # hosts como root (docker/) e do que define as ferramentas (package.json, .nvmrc). O builder
  # recebe só uma cópia do tarball, que o root não lê de novo.
  local tarball=/root/src.tar.gz pristine=/root/pristine
  "$aws" s3 cp --only-show-errors --region "$region" "s3://$bucket/src/$commit.tar.gz" "$tarball"
  chmod 0600 "$tarball"
  echo "$source_sha  $tarball" | sha256sum -c - ||
    { echo "BB_BUILD fail: o tarball do código não bate com o sha256 enviado pelo operador" >&2; exit 1; }
  install -d -m 0700 "$pristine"
  tar -xzf "$tarball" --no-same-owner -C "$pristine" docker package.json .nvmrc
  src=/home/builder/src
  install -d -o builder -g builder -m 0755 "$src"
  install -m 0644 "$tarball" /home/builder/src.tar.gz
  runuser -u builder -- tar -xzf /home/builder/src.tar.gz -C "$src"

  # Node da versão do .nvmrc e Bun do packageManager, com o checksum publicado na mesma origem.
  node_version=$(tr -d '[:space:]v' <"$pristine/.nvmrc")
  bun_version=$(jq -r '.packageManager' "$pristine/package.json" | sed -n 's/^bun@//p')
  [[ $node_version =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] && [[ $bun_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    { echo "versões inesperadas: node=$node_version bun=$bun_version" >&2; exit 1; }
  local tools=/opt/bb-srv-tools
  install -d -m 0755 "$tools"
  (
    cd "$tools"
    # .nvmrc com a versão exata (x.y.z) usa a pasta dela; com só o major, a mais nova desse major.
    if [[ $node_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then node_dir="v$node_version"; else node_dir="latest-v${node_version%%.*}.x"; fi
    curl -fsSLO "https://nodejs.org/dist/$node_dir/SHASUMS256.txt"
    node_file=$(awk '{print $2}' SHASUMS256.txt | grep -E '^node-v[0-9.]+-linux-arm64\.tar\.xz$' | grep -F "node-v$node_version" | sort -V | tail -n 1)
    [ -n "$node_file" ] || { echo "Node $node_version para linux-arm64 não encontrado" >&2; exit 1; }
    curl -fsSLO "https://nodejs.org/dist/$node_dir/$node_file"
    grep " $node_file\$" SHASUMS256.txt | sha256sum -c -
    tar -xJf "$node_file"
    ln -sfn "$tools/${node_file%.tar.xz}" "$tools/node"
    curl -fsSL -o bun-shasums.txt "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/SHASUMS256.txt"
    curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-linux-aarch64.zip"
    grep ' bun-linux-aarch64.zip$' bun-shasums.txt | sha256sum -c -
    unzip -oq bun-linux-aarch64.zip
    install -m 0755 bun-linux-aarch64/bun /usr/local/bin/bun
  )
  local path="$tools/node/bin:/usr/local/bin:/usr/bin:/bin"

  # Build do AppImage como o usuário builder, como o job linux do release (.github/workflows/release.yml).
  runuser -u builder -- env -i HOME=/home/builder PATH="$path" CI=true bash -euo pipefail -c "
    cd '$src'
    bun install --frozen-lockfile
    for runtime in codex claude grok; do
      if [ -f scripts/install-\$runtime-runtime.ts ]; then bun scripts/install-\$runtime-runtime.ts linux arm64; fi
    done
    xvfb-run -a bun run dist:linux:arm64
  "
  # O AppImage é saída do builder: o runtime dele (o código do --appimage-extract) é não confiável.
  # A extração roda como builder, numa pasta dele e sem IMDS; o root só confere o resultado.
  local appimage extract
  appimage=$(find "$src/dist" -maxdepth 1 -type f -name '*.AppImage')
  [ -n "$appimage" ] && [ "$(grep -c . <<<"$appimage")" = 1 ] ||
    { echo "BB_BUILD fail: esperava 1 AppImage em dist/, achei: ${appimage:-nenhum}" >&2; exit 1; }
  extract=$(runuser -u builder -- mktemp -d /home/builder/extract.XXXXXX)
  # Os caminhos vão como argumentos ($1, $2 do bash do builder), não dentro do texto do comando.
  # shellcheck disable=SC2016
  runuser -u builder -- env -i HOME=/home/builder PATH="$path" bash -euo pipefail -c \
    'install -m 0755 "$2" "$1/OpenBot.AppImage" && cd "$1" && ./OpenBot.AppImage --appimage-extract >/dev/null' \
    bb-extract "$extract" "$appimage"

  # Fim do código do builder: nada dele roda depois daqui (crontab, sessão, processo solto) e ele não
  # consegue mais entrar (conta travada e vencida, o que também barra o cron).
  crontab -r -u builder 2>/dev/null || true
  usermod --lock --expiredate 1 builder
  loginctl terminate-user builder 2>/dev/null || true
  for _ in $(seq 1 10); do
    pkill -KILL -u builder || true
    pgrep -u builder >/dev/null || break
    sleep 1
  done
  if pgrep -u builder >/dev/null; then echo "BB_BUILD fail: ainda há processos do builder" >&2; exit 1; fi

  # O entrypoint chama /opt/OpenBot/app/openbot (scripts/hosting/openbot-container). O fork pode
  # gerar o executável com outro nome (DESIGN 7.1): pare aqui com a causa. (test só lê metadados.)
  [ -x "$extract/squashfs-root/openbot" ] ||
    { echo "BB_BUILD fail: o AppImage não tem o executável 'openbot' (veja DESIGN 7.1: linux.executableName)." >&2; exit 1; }
  [ -x "$extract/squashfs-root/resources/hosting/openbot-container" ] ||
    { echo "BB_BUILD fail: falta resources/hosting/openbot-container." >&2; exit 1; }

  # Nenhum processo do builder vive mais: a lista de dist/ não muda entre a conferência e a cópia.
  [ ! -L "$src" ] && [ ! -L "$src/dist" ] || { echo "BB_BUILD fail: src/ ou dist/ virou link" >&2; exit 1; }
  appimage=$(find "$src/dist" -maxdepth 1 -type f -name '*.AppImage')
  [ -n "$appimage" ] && [ "$(grep -c . <<<"$appimage")" = 1 ] || { echo "BB_BUILD fail: dist/ mudou" >&2; exit 1; }
  image_dir=/root/image
  install -d -m 0700 "$image_dir"
  cp -- "$appimage" "$image_dir/OpenBot.AppImage"
  chmod 0755 "$image_dir/OpenBot.AppImage"
  electron=$(jq -r '.devDependencies.electron // .dependencies.electron // "unknown"' "$pristine/package.json")

  # O Dockerfile vem da cópia intocada; o contexto só tem o AppImage (os RUN ficam na bridge, onde o
  # hop limit 1 já bloqueia o IMDS).
  docker build --file "$pristine/docker/Dockerfile" --build-arg "VERSION=$version" --build-arg "REVISION=$commit" \
    --label "org.opencontainers.image.electron-version=$electron" --tag "$repo:$tag" "$image_dir"

  # Teste de fumaça igual ao do release: sobe com o sandbox ligado, responde e para com código 0.
  local status=''
  docker rm -f bb-srv-smoke >/dev/null 2>&1 || true
  docker run --detach --name bb-srv-smoke --shm-size 1g --security-opt "seccomp=$pristine/docker/seccomp.json" \
    --security-opt no-new-privileges:true "$repo:$tag" >/dev/null
  for _ in $(seq 1 120); do
    if docker exec bb-srv-smoke test -S /run/openbot/control.sock 2>/dev/null; then
      status=$(docker exec bb-srv-smoke openbot status 2>&1 || true)
      grep -Fxq "Account: loading" <<<"$status" || break
    fi
    sleep 1
  done
  echo "$status"
  if ! grep -Fxq "Builders Bot $version" <<<"$status" || ! grep -Fxq "Account: signed out. Sign in with: openbot login" <<<"$status"; then
    docker logs bb-srv-smoke 2>&1 | tail -n 40
    echo "BB_BUILD fail: teste de fumaça" >&2
    exit 1
  fi
  docker stop --time 60 bb-srv-smoke >/dev/null
  [ "$(docker inspect bb-srv-smoke | jq -r '.[0].State.ExitCode')" = 0 ] || { echo "BB_BUILD fail: o stop não saiu com 0" >&2; exit 1; }
  docker rm bb-srv-smoke >/dev/null

  # Bundle de operação: a pasta docker/ do mesmo commit (da cópia intocada: o bb-srv-Install roda
  # docker/instances/openbot-instance como root em todo setor), numa imagem FROM scratch com um comando.
  local ops_dir=/root/ops
  install -d -m 0700 "$ops_dir"
  cp -a "$pristine/docker" "$ops_dir/docker"
  printf 'FROM scratch\nCOPY docker /docker\nCMD ["/noop"]\n' >"$ops_dir/Dockerfile"
  docker build --label "org.opencontainers.image.revision=$commit" --label "org.opencontainers.image.version=$version" \
    --tag "$repo:$ops_tag" "$ops_dir"
  local check cid
  check=$(mktemp -d)
  cid=$(docker create "$repo:$ops_tag" /noop)
  docker cp "$cid:/docker/." "$check/"
  docker rm "$cid" >/dev/null
  [ -x "$check/instances/openbot-instance" ] && [ -f "$check/seccomp.json" ] || { echo "BB_BUILD fail: bundle de operação incompleto" >&2; exit 1; }

  docker push --quiet "$repo:$tag"
  docker push --quiet "$repo:$ops_tag"
  local image_digest ops_digest repo_name
  repo_name=${repo#*/}
  image_digest=$("$aws" ecr describe-images --region "$region" --repository-name "$repo_name" --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text)
  ops_digest=$("$aws" ecr describe-images --region "$region" --repository-name "$repo_name" --image-ids "imageTag=$ops_tag" --query 'imageDetails[0].imageDigest' --output text)
  jq -n --arg tag "$tag" --arg opsTag "$ops_tag" --arg imageDigest "$image_digest" --arg opsDigest "$ops_digest" \
    --arg version "$version" --arg commit "$commit" --arg arch "$arch" --arg electron "$electron" \
    --arg sourceSha256 "$source_sha" --arg builtAt "$(date -u +%FT%TZ)" \
    '{tag: $tag, opsTag: $opsTag, imageDigest: $imageDigest, opsDigest: $opsDigest, version: $version,
      commit: $commit, sourceSha256: $sourceSha256, arch: $arch, electronVersion: $electron, smokeTest: "passed",
      rejected: false, builtAt: $builtAt}' \
    >/root/report.json
  "$aws" s3 cp --only-show-errors --sse AES256 --region "$region" /root/report.json "s3://$bucket/reports/$tag.json"
  echo "BB_BUILD ok $tag $image_digest"
}

case ${1:-} in
  launch) shift; launch "$@" ;;
  on-host) shift; on_host "$@" ;;
  -h | --help | '') usage ;;
  *) usage; exit 1 ;;
esac
