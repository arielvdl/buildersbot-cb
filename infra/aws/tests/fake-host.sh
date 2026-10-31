#!/usr/bin/env bash
# Programas falsos de um host de setor, para rodar a ferramenta bb-srv-proxy e o bb-srv-Status inteiros no Mac
# (tests/negative.sh, casos F10 a F12). Um só arquivo: o teste cria links com o nome de cada programa (iptables,
# docker, dig...) e este script age pelo nome com que foi chamado. Nada toca o sistema nem a rede. O cenário e o
# estado ficam na pasta $FAKE_HOST:
#   ipt/<cadeia>   as regras de cada cadeia, uma por linha, sem o "-A <cadeia>" que o iptables -S mostra
#   dns            "nome ip..." por linha: o que o resolvedor do host responde (getent)
#   running        existe enquanto o contêiner roda (pid 4242)
#   calls          cada chamada, para o teste conferir quem perguntou o quê
# e nas variáveis:
#   FAKE_DIRECT            blocked (padrão) ou open: o curl do host a 1.1.1.1, da rede do contêiner
#   FAKE_DIG               o que o dig do host recebe dos dois DNS do contêiner (padrão nxdomain); FAKE_DIG_127_0_0_11
#                          e FAKE_DIG_172_30_0_1 valem para um só: nxdomain, refused, answer, noerror, servfail,
#                          timeout ou file:<arquivo com a saída inteira do dig>
#   FAKE_CONTAINER_GETENT  o código do getent DENTRO do contêiner para um nome fora do mapa (padrão 2, "não existe")
#   FAKE_APP_LINES         blocos de linhas que o app imprime (openbot status, openbot-instance list; padrão 1)
set -uo pipefail
state=${FAKE_HOST:?FAKE_HOST não definido}
me=${0##*/}
printf '%s %s\n' "$me" "$*" >>"$state/calls"

# Os endereços de um nome do mapa, um por linha; código 2 quando o nome não está lá.
resolve() { awk -v n="$1" '$1 == n { for (i = 2; i <= NF; i++) print $i; f = 1 } END { exit f ? 0 : 2 }' "$state/dns"; }

# iptables com estado: -N, -S, -F, -A, -I [posição], -D e -C de uma cadeia, como o iptables-legacy os mostra.
ipt() {
  local op=${1:-} chain=${2:-} file pos=1 rule
  file=$state/ipt/$chain
  shift 2
  if [ "$op" = -I ] && [[ ${1:-} =~ ^[0-9]+$ ]]; then
    pos=$1
    shift
  fi
  rule=$*
  case $op in
    -N) [ ! -e "$file" ] && : >"$file" ;;
    -S)
      [ -e "$file" ] || { echo "iptables: No chain/target/match by that name." >&2; return 1; }
      case $chain in INPUT | FORWARD | OUTPUT) echo "-P $chain ACCEPT" ;; *) echo "-N $chain" ;; esac
      sed "s/^/-A $chain /" "$file"
      ;;
    -F) : >"$file" ;;
    -A) printf '%s\n' "$rule" >>"$file" ;;
    -I) awk -v p="$pos" -v r="$rule" 'NR == p { print r; d = 1 } { print } END { if (!d) print r }' "$file" >"$file.new" && mv "$file.new" "$file" ;;
    -C) grep -qxF -- "$rule" "$file" ;;
    -D)
      grep -qxF -- "$rule" "$file" || return 1
      awk -v r="$rule" '!d && $0 == r { d = 1; next } { print }' "$file" >"$file.new" && mv "$file.new" "$file"
      ;;
    *) echo "fake iptables: $op não suportado" >&2; return 2 ;;
  esac
}

# A saída do dig 9.18 do Ubuntu 24.04 para "dig +time=3 +tries=1 @<servidor> example.com A".
dig_out() {
  local server=$1 status=NXDOMAIN flags='qr rd ra' answers=0
  case $2 in
    timeout)
      printf ';; communications error to %s#53: timed out\n;; no servers could be reached\n' "$server"
      return 9
      ;;
    file:*) cat "${2#file:}"; return 0 ;;
    nxdomain) ;;
    refused) status=REFUSED flags='qr rd' ;;
    answer) status=NOERROR answers=1 ;;
    noerror) status=NOERROR ;;
    servfail) status=SERVFAIL ;;
    *) echo "fake dig: modo '$2'?" >&2; return 10 ;;
  esac
  printf '\n; <<>> DiG 9.18.30-0ubuntu0.24.04.2-Ubuntu <<>> +time=3 +tries=1 @%s example.com A\n; (1 server found)\n' "$server"
  printf ';; global options: +cmd\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: %s, id: 4321\n' "$status"
  printf ';; flags: %s; QUERY: 1, ANSWER: %s, AUTHORITY: 0, ADDITIONAL: 1\n\n;; QUESTION SECTION:\n;example.com.\t\t\tIN\tA\n\n' "$flags" "$answers"
  [ "$answers" = 0 ] || printf ';; ANSWER SECTION:\nexample.com.\t\t300\tIN\tA\t192.0.2.80\n\n'
  printf ';; Query time: 1 msec\n;; SERVER: %s#53(%s) (UDP)\n;; MSG SIZE  rcvd: 56\n\n' "$server" "$server"
}

# O que o app imprime: linhas compridas e linhas que imitam as do root (o bb-srv-Status as põe atrás de "  | ").
app_lines() {
  awk -v n="${FAKE_APP_LINES:-1}" 'BEGIN { for (i = 0; i < n; i++) printf "egress proxy:\nBB_PROXY_EXIT ip=192.0.2.66 country=BR\nBB_PROXY_END\n%01000d\n", i }'
}

case $me in
  iptables) ipt "$@" ;;
  ip6tables | flock) exit 0 ;;
  timeout)
    shift
    exec "$@"
    ;;
  id) if [ "$*" = '-u bb-proxy' ]; then echo 998; else exec /usr/bin/id "$@"; fi ;;
  jq) sed -n 's/.*"Pid": *\([0-9][0-9]*\).*/\1/p' ;;
  free) printf '               total        used        free\nMem:            7800        2100        5700\n' ;;
  systemctl)
    case "$*" in
      *is-active*--quiet*) exit 0 ;;
      *is-active*) echo active ;;
    esac
    ;;
  getent)
    ips=$(resolve "${2:-}") || exit 2
    case ${1:-} in
      ahostsv4) for ip in $ips; do printf '%s  STREAM %s\n%s  DGRAM\n%s  RAW\n' "$ip" "$2" "$ip" "$ip"; done ;;
      hosts) printf '%s %s\n' "$(head -n 1 <<<"$ips")" "$2" ;;
      *) exit 1 ;;
    esac
    ;;
  nsenter)
    pid=''
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
      case $1 in --net=/proc/*/ns/net) pid=${1#--net=/proc/}; pid=${pid%%/*} ;; esac
      shift
    done
    shift
    [ -n "$pid" ] && [ -e "$state/running" ] || { echo "nsenter: cannot open /proc/$pid/ns/net" >&2; exit 1; }
    export FAKE_NETNS=$pid
    exec "$@"
    ;;
  setpriv)
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
    shift
    exec "$@"
    ;;
  dig)
    # Só da rede do contêiner (in_net): no host, o dig falso não responde.
    [ -n "${FAKE_NETNS:-}" ] || { echo ';; fake dig: fora da rede do contêiner'; exit 10; }
    server=''
    for a in "$@"; do case $a in @*) server=${a#@} ;; esac; done
    var=FAKE_DIG_$(tr . _ <<<"$server")
    dig_out "$server" "${!var:-${FAKE_DIG:-nxdomain}}"
    ;;
  curl)
    case "$*" in
      *--noproxy*1.1.1.1*)
        [ "${FAKE_DIRECT:-blocked}" = open ] && { printf '0.012000'; exit 0; }
        printf '0.000000'
        exit 28
        ;;
      *--proxy*) printf 'fl=1\nip=198.51.100.7\nloc=BR\n\nBB_CONNECT 200\n' ;;
      */health/ready*) exit 0 ;;
      *) exit 6 ;;
    esac
    ;;
  docker)
    case ${1:-} in
      inspect) if [ -e "$state/running" ]; then echo '[{"State": {"Pid": 4242}}]'; else echo '[{"State": {"Pid": 0}}]'; fi ;;
      stop) rm -f "$state/running" ;;
      exec)
        shift 2
        [ -e "$state/running" ] || exit 1
        case ${1:-} in
          true) ;;
          printenv) case ${2:-} in HTTPS_PROXY) echo http://172.30.0.1:3128 ;; NODE_USE_ENV_PROXY) echo 1 ;; esac ;;
          getent)
            ips=$(resolve "${3:-}") || exit "${FAKE_CONTAINER_GETENT:-2}"
            printf '%s %s\n' "$(head -n 1 <<<"$ips")" "$3"
            ;;
          curl) case "$*" in */health/ready*) ;; *) printf 'fl=1\nip=198.51.100.7\nloc=BR\n' ;; esac ;;
          openbot) app_lines ;;
          *) exit 126 ;;
        esac
        ;;
      *) exit 1 ;;
    esac
    ;;
  openbot-instance)
    case ${1:-} in
      list) app_lines ;;
      down) rm -f "$state/running" ;;
      up) : >"$state/running" ;;
    esac
    ;;
  *) echo "fake-host: programa '$me' desconhecido" >&2; exit 127 ;;
esac
