-- Real gap found live 2026-09-07: "payment mandar recibo pedir release release recuperar enviar
-- carrier????? esto esta hecho?" — the plant-payment email already asks the plant for the RELEASE
-- NUMBER, but there was never anywhere to actually record the value once the plant replies with it,
-- nor any way to relay it to the carrier so they can use it at pickup. release_number_alert_sent_at
-- (already existed) only tracks whether the reminder-to-go-get-it fired — this is the value itself.
alter table shipments add column release_number text;
