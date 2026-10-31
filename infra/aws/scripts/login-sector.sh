#!/usr/bin/env bash
# Faz o login do servidor de um setor com a CONTA DONA daquele setor (DESIGN 3.3 e 11.1).
# Abre uma sessão SSM com o documento bb-srv-<setor>-Login, que só roda
# `openbot login <e-mail> --name '<nome>'` no container. O código chega na caixa da conta dona e o
# operador digita o código na sessão. Nada é gravado em disco aqui.
#
# Regras: uma conta dona por setor, nunca reutilizada; a conta pessoal do Ariel nunca faz login num
# servidor de setor (a sessão do dono fica no /data, que os agentes leem).
#
# Uso: scripts/login-sector.sh <setor> <e-mail-da-conta-dona> "<Nome do servidor>"
# Requer o session-manager-plugin do AWS CLI.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

[ "$#" -eq 3 ] || { sed -n '2,12p' "$0"; exit 1; }
sector=$1
email=$2
name=$3
valid_sector "$sector"
valid_email "$email"
# O mesmo padrão do documento bb-srv-<setor>-Login: 3 a 32 letras, dígitos, espaços e "-", começando por
# letra ou dígito, sem aspas (o valor fica entre aspas simples no comando do documento).
[[ $name =~ ^[A-Za-z0-9][A-Za-z0-9\ -]{2,31}$ ]] || die "nome do servidor inválido: 3 a 32 letras, dígitos, espaços e -, começando por letra ou dígito (ex.: \"CB Financeiro\", \"CB rh-juridico\")."
case $email in
  bb-*@*) ;;
  *) warn "o e-mail não segue o padrão bb-<setor>@... das contas donas. Confirme que NÃO é uma conta pessoal."
     confirm "Usar $email como conta dona EXCLUSIVA do setor $sector? Digite 'exclusiva':" exclusiva ;;
esac
command -v session-manager-plugin >/dev/null || die "instale o session-manager-plugin do AWS CLI."

bb_check_access
instance=$(sector_instance "$sector")
params=$(jq -cn --arg email "$email" --arg name "$name" '{email: [$email], name: [$name]}')
say "== login do setor $sector como $email (digite o código que chegar nessa caixa)"
aws_cb ssm start-session --target "$instance" --document-name "bb-srv-$sector-Login" --parameters "$params"
say "Confira: scripts/status.sh $sector --deep  (a linha Account deve mostrar $email)"
