import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/guard";

export const messages = {
  "status.guard.askAction": "O Guarda pede que você confira esta etapa. {reason}",
  "status.guard.askActionReviewed":
    "O Guarda e o modelo revisor pedem que você confira esta etapa. {reason} O modelo diz: {detail}",
  "status.guard.askContentFrom":
    "O Guarda encontrou uma possível injeção de prompt no que {tool} leu de {origin}. {reason} Permitir deixa o agente ler isso como dado. Negar segura o conteúdo.",
  "status.guard.askContentTool":
    "O Guarda encontrou uma possível injeção de prompt no que {tool} devolveu. {reason} Permitir deixa o agente ler isso como dado. Negar segura o conteúdo.",
  "status.guard.askContentFromReviewed":
    "O Guarda e o modelo revisor encontraram uma possível injeção de prompt no que {tool} leu de {origin}. {reason} O modelo diz: {detail} Permitir deixa o agente ler isso como dado. Negar segura o conteúdo.",
  "status.guard.askContentToolReviewed":
    "O Guarda e o modelo revisor encontraram uma possível injeção de prompt no que {tool} devolveu. {reason} O modelo diz: {detail} Permitir deixa o agente ler isso como dado. Negar segura o conteúdo.",
  "status.guard.finding.override": "O conteúdo manda o agente ignorar as instruções dele.",
  "status.guard.finding.newInstructions": "O conteúdo dá novas instruções ao agente.",
  "status.guard.finding.promptLeak": "O conteúdo pede que o agente revele as instruções dele.",
  "status.guard.finding.roleChange": "O conteúdo tenta dar um novo papel ao agente.",
  "status.guard.finding.roleMarker": "O conteúdo imita uma mensagem do sistema ou do desenvolvedor.",
  "status.guard.finding.aiAddressed": "O conteúdo dá instruções a um agente de IA.",
  "status.guard.finding.judgeManipulation": "O conteúdo tenta fazer a verificação de segurança aprová-lo.",
  "status.guard.finding.hiddenUnicodeTags": "O conteúdo tem caracteres Unicode de tag invisíveis.",
  "status.guard.finding.hiddenBidi": "O conteúdo tem caracteres que invertem a direção da leitura.",
  "status.guard.finding.hiddenZeroWidth": "O conteúdo tem muitos caracteres invisíveis.",
  "status.guard.finding.hiddenMarkup": "O conteúdo esconde instruções em marcação que o leitor não vê.",
  "status.guard.finding.imageExfiltration": "O conteúdo cria um link de imagem que envia dados para outro site.",
  "status.guard.finding.exfiltrationRequest": "O conteúdo pede para enviar dados para outro site.",
  "status.guard.finding.secretRequest": "O conteúdo menciona segredos.",
  "status.guard.finding.secretSendRequest": "O conteúdo pede para enviar segredos.",
  "status.guard.finding.remoteCodeRequest": "O conteúdo pede para rodar um script da internet.",
  "status.guard.finding.reverseShell": "O comando abre um shell remoto.",
  "status.guard.finding.encodedExecution": "O comando roda código codificado e escondido.",
  "status.guard.finding.pipeToShell": "O comando roda na hora um script baixado da internet.",
  "status.guard.finding.secretFileUpload": "A ação lê segredos e os envia pela rede.",
  "status.guard.finding.secretVariableInTransfer": "A ação envia uma variável secreta pela rede.",
  "status.guard.finding.secretInTransfer": "A ação envia um valor secreto para fora deste computador.",
  "status.guard.finding.dataInUrl": "A URL carrega um bloco de dados.",
  "status.guard.finding.credentialsInUrl": "A URL carrega um nome de usuário ou uma senha.",
  "status.guard.finding.pasteHost": "A ação envia dados para um site que guarda envios anônimos.",
  "status.guard.finding.pageScriptExfiltration":
    "O script da página lê cookies ou o armazenamento e os envia para fora.",
  "status.guard.finding.pageScriptNetwork": "O script da página faz uma requisição de rede.",
  "status.guard.finding.vendorInstruction":
    "O resultado pede ao agente um passo para um fornecedor, como instalar uma ferramenta, rodar um script, criar uma conta ou dar estrela a um projeto.",
  "status.guard.finding.cookieInTransfer":
    "A ação envia um cookie, uma sessão ou um token de acesso para fora deste computador.",
  "status.guard.finding.textInTransfer":
    "A ação envia um texto livre longo para fora deste computador, como uma conversa colada.",
  "status.guard.finding.blobInTransfer": "A ação envia um bloco longo de dados codificados para fora deste computador.",
  "status.guard.finding.incompleteScan": "O Guarda não conseguiu ler este item inteiro.",
} as const satisfies PartialTranslation<typeof source>;
