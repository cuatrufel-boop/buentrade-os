// BuenTrade AI Assistant — simple client-side FAQ logic
const btReplies = [
  { k: ["hi","hello","hey"], a: "Hi! I'm the BuenTrade Assistant. Ask me about our beef, pork, poultry, or Caribbean products, shipping regions, or how to request a quote." },
  { k: ["beef","pork","poultry","meat","protein"], a: "We source beef, pork, and poultry from the U.S., Brazil, and Canada for clients in Mexico. Want me to help you start a quote request?" },
  { k: ["caribbean","dry goods","consumer","products"], a: "We distribute dry goods and consumer products across the Caribbean market, shipped reliably and on schedule." },
  { k: ["quote","price","cost","pricing"], a: "I can pass your request to our team. Please fill out the contact form below with your product and volume, and we'll follow up fast." },
  { k: ["mexico"], a: "Yes — we supply beef, pork, and poultry to clients across Mexico from the U.S., Brazil, and Canada." },
  { k: ["shipping","delivery","time","how long"], a: "Shipping times vary by product and destination. Share your location and product in the contact form for an accurate estimate." },
  { k: ["contact","talk","human","agent"], a: "Of course — you can reach our team directly at buentrade2026@gmail.com or WhatsApp +34 666 318 864." },
];

function btMatch(msg) {
  const lower = msg.toLowerCase();
  for (const r of btReplies) {
    if (r.k.some(k => lower.includes(k))) return r.a;
  }
  return "Thanks for your message! For detailed quotes, please use the contact form below or email buentrade2026@gmail.com — our team replies quickly.";
}

function btToggle() {
  const win = document.getElementById('ai-chat-window');
  win.classList.toggle('open');
}

function btSend() {
  const input = document.getElementById('ai-chat-input');
  const body = document.getElementById('ai-chat-body');
  const text = input.value.trim();
  if (!text) return;

  const userMsg = document.createElement('div');
  userMsg.className = 'chat-msg user';
  userMsg.textContent = text;
  body.appendChild(userMsg);

  input.value = '';

  setTimeout(() => {
    const botMsg = document.createElement('div');
    botMsg.className = 'chat-msg bot';
    botMsg.textContent = btMatch(text);
    body.appendChild(botMsg);
    body.scrollTop = body.scrollHeight;
  }, 450);

  body.scrollTop = body.scrollHeight;
}

document.addEventListener('DOMContentLoaded', () => {
  const inputEl = document.getElementById('ai-chat-input');
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btSend();
    });
  }
});
