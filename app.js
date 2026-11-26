"use strict";

const byId = (id) => document.getElementById(id);
const statusLabels = {open: "Recebido", working: "Em correção", resolved: "Resolvido"};
const config = window.PORT_HUB_CONFIG;
const redirectTo = location.origin + location.pathname;
const pageSize = 15;
let client;
let user;
let admin = false;
let recovery = false;
let page = 0;
let requestId = 0;

function message(text) {
  byId("message").textContent = text;
  byId("message").hidden = !text;
}

function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

async function busy(form, action) {
  const buttons = [...form.querySelectorAll("button")].filter((button) => !button.disabled);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await action();
  } catch {
    message("Não foi possível concluir a operação. Confira sua conexão ou os dados informados e tente novamente.");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function checked(result) {
  if (result.error) throw result.error;
  return result.data;
}

function rtfText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\\{}\n\t]|[^\x20-\x7e]/g, (character) => {
    if (character === "\n") return "\\line ";
    if (character === "\t") return "\\tab ";
    if ("\\{}".includes(character)) return "\\" + character;
    const code = character.charCodeAt(0);
    return "\\u" + (code > 32767 ? code - 65536 : code) + "?";
  });
}

function ticketExportFields(ticket) {
  return [
    ["Protocolo", ticket.id],
    ["Título", ticket.title],
    ["Data de abertura", new Date(ticket.created_at).toLocaleString("pt-BR")],
    ["Modelo do console", ticket.console_model],
    ["Sistema operacional", ticket.os],
    ["Versão do Hub", ticket.hub_version || "Não informada"],
    ["Status", statusLabels[ticket.status]],
    ["Progresso", ticket.progress + "%"],
    ["Descrição", ticket.description],
    ["Atualização da equipe", ticket.resolution || "Sem atualização"],
    ["Anexo", ticket.attachment_name || "Sem anexo"]
  ];
}

function exportTicket(ticket) {
  const paragraphs = ticketExportFields(ticket).map(([label, value]) =>
    "\\b " + rtfText(label) + "\\b0\\line " + rtfText(value) + "\\par\\par "
  ).join("");
  const documentText = "{\\rtf1\\ansi\\uc1\\deff0{\\fonttbl{\\f0 Arial;}}"
    + "\\f0\\fs36\\b R36S PORT HUB\\b0\\par\\fs24 Central de suporte\\par\\par "
    + paragraphs + "}";
  const url = URL.createObjectURL(new Blob([documentText], {type: "application/rtf"}));
  const link = node("a");
  link.href = url;
  link.download = "chamado-r36s-" + ticket.id + ".rtf";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function printTicket(ticket) {
  document.getElementById("ticket-print-document")?.remove();
  const sheet = node("article");
  sheet.id = "ticket-print-document";
  sheet.append(node("h1", "R36S PORT HUB"), node("p", "Central de suporte"));
  const fields = node("dl");
  for (const [label, value] of ticketExportFields(ticket)) {
    fields.append(node("dt", label), node("dd", value));
  }
  sheet.append(fields);
  document.body.append(sheet);
  document.body.classList.add("printing-ticket");
  window.addEventListener("afterprint", () => {
    sheet.remove();
    document.body.classList.remove("printing-ticket");
  }, {once: true});
  window.print();
}

function renderTicket(ticket) {
  const card = node("details");
  card.className = "ticket";
  const summary = node("summary", ticket.title);
  const status = node("p", statusLabels[ticket.status] + " · " + ticket.progress + "%");
  status.className = "status";
  const bar = node("progress");
  bar.max = 100;
  bar.value = ticket.progress;
  bar.setAttribute("aria-label", "Progresso da correção");
  card.append(summary, status, bar, node("p", [ticket.console_model, ticket.os, ticket.hub_version].filter(Boolean).join(" · ")),
    node("small", new Date(ticket.created_at).toLocaleString("pt-BR")), node("p", ticket.description));
  if (ticket.resolution) card.append(node("strong", "Atualização da equipe"), node("p", ticket.resolution));
  if (ticket.attachment_name) {
    const download = node("button", "Baixar " + ticket.attachment_name);
    download.className = "secondary";
    download.onclick = () => busy(card, async () => {
      const data = checked(await client.from("support_tickets").select("attachment_data").eq("id", ticket.id).single());
      const bytes = Uint8Array.from(atob(data.attachment_data), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], {type: "application/octet-stream"}));
      const link = node("a");
      link.href = url;
      link.download = ticket.attachment_name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    card.append(download);
  }
  if (admin) {
    const exportButton = node("button", "Exportar para Word");
    exportButton.className = "secondary";
    exportButton.onclick = () => exportTicket(ticket);
    const actions = node("div");
    actions.className = "actions";
    const pdfButton = node("button", "Exportar para PDF");
    pdfButton.className = "secondary";
    pdfButton.onclick = () => printTicket(ticket);
    const deleteButton = node("button", "Excluir chamado");
    deleteButton.className = "secondary danger";
    deleteButton.onclick = () => {
      if (!window.confirm("Excluir este chamado e seu anexo permanentemente?")) return;
      busy(card, async () => {
        checked(await client.from("support_tickets").delete().eq("id", ticket.id).select("id").single());
        page = 0;
        await loadTickets();
        message("Chamado excluído.");
      });
    };
    actions.append(exportButton, pdfButton, deleteButton);
    card.append(actions, editTicket(ticket));
  }
  return card;
}

function editTicket(ticket) {
  const form = node("form");
  const note = node("textarea");
  note.maxLength = 4000;
  note.rows = 3;
  note.value = ticket.resolution;
  const noteLabel = node("label", "O que foi feito?");
  noteLabel.append(note);
  const progress = node("input");
  progress.type = "number";
  progress.required = true;
  progress.min = 0;
  progress.max = 100;
  progress.value = ticket.progress;
  const progressLabel = node("label", "Progresso da correção (0 a 100%)");
  progressLabel.append(progress);
  form.append(noteLabel, progressLabel, node("button", "Salvar atualização"));
  form.onsubmit = (event) => {
    event.preventDefault();
    busy(form, async () => {
      const saved = checked(await client.from("support_tickets").update({
        progress: progress.valueAsNumber, resolution: note.value.trim()
      }).eq("id", ticket.id).select("id").single());
      if (saved.id) message("Atualização salva.");
      await loadTickets(ticket.id);
    });
  };
  return form;
}

async function loadTickets(expandedId) {
  const currentRequest = ++requestId;
  byId("tickets").textContent = "Carregando chamados…";
  byId("prev").hidden = true;
  byId("next").hidden = true;
  try {
    let query = client.from("support_tickets")
      .select("id,title,console_model,os,hub_version,description,status,progress,resolution,attachment_name,created_at")
      .order("created_at", {ascending: false}).order("id").range(page * pageSize, (page + 1) * pageSize);
    const filter = byId("filter").value;
    if (filter) query = query.eq("status", filter);
    const rows = checked(await query);
    if (currentRequest !== requestId) return;
    byId("tickets").replaceChildren(...rows.slice(0, pageSize).map((ticket) => {
      const card = renderTicket(ticket);
      card.open = ticket.id === expandedId;
      return card;
    }));
    if (!rows.length) byId("tickets").textContent = "Nenhum chamado neste filtro.";
    byId("prev").hidden = page === 0;
    byId("next").hidden = rows.length <= pageSize;
  } catch {
    if (currentRequest === requestId) byId("tickets").textContent = "Falha ao carregar chamados. Use Atualizar para tentar novamente.";
  }
}

async function showSession(session) {
  user = session?.user;
  byId("logout").hidden = !user;
  byId("auth").hidden = Boolean(user && !recovery);
  byId("login").hidden = recovery;
  byId("reset").hidden = !recovery;
  byId("workspace").hidden = true;
  if (!user || recovery) {
    requestId++;
    byId("tickets").replaceChildren();
    if (!user) byId("report").reset();
    return;
  }
  const userId = user.id;
  const role = await client.rpc("support_is_admin");
  if (user?.id !== userId) return;
  admin = !role.error && role.data === true;
  byId("account").textContent = user.email + (admin ? " · Administrador" : "");
  byId("list-title").textContent = admin ? "Todos os chamados" : "Meus chamados";
  byId("workspace").hidden = false;
  page = 0;
  await loadTickets();
}

function onSubmit(id, action) {
  const form = byId(id);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    busy(form, () => action(new FormData(form), event.submitter?.value, form));
  });
}

async function encodeAttachment(file) {
  if (!file.size) return {};
  if (file.size > 4 * 1024 * 1024 || file.name.length > 180 || !/\.(png|jpe?g|webp|txt|log)$/i.test(file.name)) {
    message("Selecione um arquivo PNG, JPG, WebP, TXT ou LOG de até 4 MB.");
    return null;
  }
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return {attachment_name: file.name, attachment_data: data};
}

function start() {
  if (!config?.url || !config?.publishableKey || !window.supabase) {
    message("O portal aguarda a ativação do serviço de contas e chamados.");
    byId("auth").querySelectorAll("button,input").forEach((element) => { element.disabled = true; });
    return;
  }
  client = window.supabase.createClient(config.url, config.publishableKey, {auth: {flowType: "pkce"}});
  let sessionUser;
  client.auth.onAuthStateChange((event, session) => {
    const id = session?.user.id;
    if (event === "PASSWORD_RECOVERY") recovery = true;
    if (event === "SIGNED_OUT") recovery = false;
    if (id === sessionUser && !["INITIAL_SESSION", "PASSWORD_RECOVERY", "SIGNED_OUT"].includes(event)) return;
    sessionUser = id;
    setTimeout(() => showSession(session).catch(() => message("Erro ao carregar a conta.")), 0);
  });

  onSubmit("login", async (data, action) => {
    const credentials = {email: data.get("email"), password: data.get("password")};
    if (action === "signup") {
      const result = checked(await client.auth.signUp({...credentials, options: {emailRedirectTo: redirectTo}}));
      message(result.session ? "Conta criada." : "Confira seu e-mail para confirmar o cadastro.");
    } else {
      const result = await client.auth.signInWithPassword(credentials);
      message(result.error ? "Falha ao entrar. Confira a senha e a confirmação do e-mail." : "");
    }
  });
  byId("recover").onclick = () => busy(byId("auth"), async () => {
    const email = byId("login").elements.email;
    if (!email.reportValidity()) return;
    checked(await client.auth.resetPasswordForEmail(email.value, {redirectTo}));
    message("Se a conta existir, você receberá um link de redefinição.");
  });
  onSubmit("reset", async (data, _action, form) => {
    checked(await client.auth.updateUser({password: data.get("password")}));
    form.reset();
    recovery = false;
    message("Senha atualizada.");
    await showSession(checked(await client.auth.getSession()).session);
  });
  byId("logout").onclick = async () => {
    const result = await client.auth.signOut();
    message(result.error ? "Não foi possível sair. Tente novamente." : "");
  };
  onSubmit("report", async (data, _action, form) => {
    const attachment = await encodeAttachment(data.get("attachment"));
    if (!attachment) return;
    const fields = Object.fromEntries(["title", "console_model", "os", "hub_version", "description"].map((key) => [key, data.get(key).trim()]));
    if (["title", "console_model", "os", "description"].some((key) => !fields[key])) {
      message("Preencha o título, o modelo, o sistema e a descrição.");
      return;
    }
    const row = checked(await client.from("support_tickets").insert({...fields, ...attachment}).select("id").single());
    form.reset();
    message("Chamado enviado.");
    page = 0;
    byId("filter").value = "";
    await loadTickets(row.id);
  });
  byId("refresh").onclick = () => loadTickets();
  byId("filter").onchange = () => { page = 0; loadTickets(); };
  byId("prev").onclick = () => { page = Math.max(0, page - 1); loadTickets(); };
  byId("next").onclick = () => { page++; loadTickets(); };
}

start();
