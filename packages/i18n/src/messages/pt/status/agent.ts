import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/agent";

export const messages = {
  "status.agent.claudeWriteOutside":
    "Gravar em {path}, fora do espaço de trabalho do agente, da pasta compartilhada e das pastas temporárias.",
  "status.agent.contextCleared": "Contexto limpo. Um novo chat começa aqui.",
  "status.agent.instructionsChanged": "Atualizou suas instruções",
  "status.agent.modelSwitchedForLimit": "Limite de uso atingido. O modelo mudou para {model}.",
  "status.agent.modelReturnedAfterLimit": "O limite de uso terminou. O modelo voltou para {model}.",
  "status.agent.modelSwitchedForError": "Erro do provedor. O modelo mudou para {model}.",
  "status.agent.modelReturnedAfterError": "Após o erro do provedor, o modelo voltou para {model}.",
  "status.agent.marketplaceSuggested": "App da loja sugerido: {app}.",
  "status.agent.channelMemberAdded": "{agent} adicionou {member} ao canal. {person} pediu.",
  "status.agent.channelMemberRemoved": "{agent} removeu {member} do canal. {person} pediu.",
  "status.agent.channelInstructionsChanged": "{agent} mudou as instruções do canal. {person} pediu.",
  "status.agent.channelRoutineCreated": "{agent} criou a rotina {routine}. {person} pediu.",
  "status.agent.channelRoutineUpdated": "{agent} mudou a rotina {routine}. {person} pediu.",
  "status.agent.channelRoutineDeleted": "{agent} excluiu a rotina {routine}. {person} pediu.",
  "status.agent.screenCaptureScreen": "Capturar a tela principal e enviar a imagem ao modelo do agente.",
  "status.agent.screenCaptureChannel":
    "A imagem aparece no canal {channel}, e cada membro deste servidor que lê o canal pode vê-la.",
  "status.agent.screenCaptureDisplay": "Capturar o monitor {name} e enviar a imagem ao modelo do agente.",
  "status.agent.screenCaptureWindow": "Capturar a janela {name} e enviar a imagem ao modelo do agente.",
  "status.agent.screenCaptureRegion":
    "Capturar a área da tela em {x}, {y}, {width} × {height} pontos e enviar a imagem ao modelo do agente.",
  "status.agent.screenCaptureProgress": "Pedindo para capturar a tela…",
  "status.agent.screenCaptureReviewing": "Analisando a captura de tela…",
  "status.agent.browserOpening": "Abrindo uma página da web…",
  "status.agent.browserReading": "Lendo a página da web…",
  "status.agent.browserClicking": "Clicando na página da web…",
  "status.agent.browserTyping": "Digitando na página da web…",
  "status.agent.browserActing": "Usando a página da web…",
  "status.agent.browserReviewing": "Analisando a página da web…",
  "status.agent.memoriesSearching": "Pesquisando suas memórias…",
  "status.agent.memoriesSearched": {
    one: "Pesquisou suas memórias: {count} encontrada",
    other: "Pesquisou suas memórias: {count} encontradas",
  },
  "status.agent.memoriesUpdating": "Atualizando suas memórias…",
  "status.agent.skillUsing": "Usando a habilidade {name}…",
  "status.agent.skillReading": "Lendo uma habilidade…",
  "status.agent.memoryChanges": "Memórias: {saved} salvas, {updated} atualizadas, {forgotten} esquecidas.",
  "status.agent.memoryChangesWithConflicts":
    "Memórias: {saved} salvas, {updated} atualizadas, {forgotten} esquecidas, {notChanged} não alteradas porque outro tópico as alterou antes.",
  "status.agent.planContinues": "O plano tem etapas abertas. O agente continua ({current} de {limit}).",
  "status.agent.branchTitle": "Chat ramificado",
  "status.agent.connectionConfirmCost":
    "Um agente quer executar {endpoint} do catálogo de ferramentas. Custa até {amount}, pago por {org}. Permitir envia esta chamada uma vez. Negar cancela.",
  "status.agent.connectionConfirmCostPersonal":
    "Um agente quer executar {endpoint} do catálogo de ferramentas com o seu plano pessoal. Custa até {amount}. Permitir envia esta chamada uma vez. Negar cancela.",
  "status.agent.connectionConfirmCostOnHub":
    "Um agente quer executar {endpoint} do catálogo de ferramentas. Custa até {amount}, pago por {org}. Você aprova este custo no Hub da Cultura Builder: Permitir abre o Hub no navegador, e a chamada roda uma vez depois que você aprovar lá. Negar cancela.",
  "status.agent.connectionConfirmCostOnHubPersonal":
    "Um agente quer executar {endpoint} do catálogo de ferramentas com o seu plano pessoal. Custa até {amount}. Você aprova este custo no Hub da Cultura Builder: Permitir abre o Hub no navegador, e a chamada roda uma vez depois que você aprovar lá. Negar cancela.",
  "status.agent.connectionChoosePayer":
    "Quem paga por {connection}? Permitir faz {org} pagar esta chamada e as próximas. Negar não usa esta organização.",
  "status.agent.connectionChoosePayerPersonal":
    "Pagar {connection} com o seu plano pessoal? Permitir faz o plano pessoal pagar esta chamada e as próximas.",
  "status.agent.connectionPeopleData":
    "Um agente quer buscar dados de pessoas com {endpoint}: {subjects}. Os dados vão para o Cultura Builder, para o treg.to (EUA) e para o fornecedor do endpoint. Permitir vale para as próximas buscas sobre pessoas nesta conversa.",
} as const satisfies PartialTranslation<typeof source>;
