// AgentMail inbox (london@agentmail.to) as the source of alert mails. n8n polls the inbox,
// fetches each unprocessed message and labels it once the run has saved its listings.
// Field names are the API's wire format (snake_case), as in the official SDK's serializers.

export const AGENTMAIL_API = "https://api.agentmail.to/v0";
export const PROCESSED_LABEL = "london-processed";

/** Message ids from a list response that this workflow has not processed yet, oldest first. */
export function newMessageIds(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .filter((m) => !(m.labels ?? []).includes(PROCESSED_LABEL))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    .map((m) => m.message_id);
}

/** Full message (GET /inboxes/{inbox}/messages/{id}) → the mail shape parseMail expects. */
export function toMail(m) {
  return {
    id: m.message_id,
    from: m.from ?? "",
    subject: m.subject ?? "",
    date: m.timestamp ?? null,
    html: m.html ?? null,
    text: m.text ?? m.extracted_text ?? "",
  };
}
