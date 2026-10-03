// The Freight Order PDF (the document the carrier receives), drawn once for every page that sends it (orders.html and offers.html). It is a form:
// every field is a cell of one grid, label on top and value below, rows that line up edge to edge. Uses each page's own PDF helpers and constants
// (pdfDoc, pdfHeader, pdfSignatureBlock, pdfFooter, CONTACT_EMAIL_FO, btNum, fmtDateStr, todayStr), which both pages define.
//
// Layout, top to bottom: ISSUE DATE · PU DATE · DELIVERY DATE / VENDOR (the carrier: name and contact) · CLIENT NAME / PICK UP ADDRESS · DELIVERY ADDRESS
// / STOP OVER · APPT. / CHECK IN # · RELEASE # / TEMPERATURE SETTING · ESTIMATED WEIGHT · CLIENT ORDER # / PRODUCT / COMMODITY / Service Purchased · Amount
// / PICK UP INSTRUCTIONS · DELIVERY INSTRUCTIONS · IMPORTANT NOTICE / signatures.

const FO_PICKUP_INSTRUCTIONS = "Appointments must be made with the plant/cold storage facility 24-48 hours prior to pick up date. Only on trucks booked 24 hours prior to pick up are considered exceptions. If the facility is a first come first serve (FCFS), call 24-48 hours prior to make sure that the load is ready for pick up. We will not be responsible for any TONU if there is no confirmation that the plant advised the load was ready when it was not. Important: please take note of the employee confirming P/U information = email the same employee confirming the load is ready, time & date of pick up. For FCFS please have email confirming product is ready to be picked up on the set date.";
const FO_DELIVERY_INSTRUCTIONS = "USDA inspections - if this load needs USDA inspection at destination or an in transit point, the driver needs to check in before 6am at the inspection facility on the delivery or in transit date. Checking in after 6am can result in delays, possible layover and a late inspection fee of $150 USD which the driver will be responsible for.";
const FO_IMPORTANT_NOTICE = "All trucks must carry adequate insurance. You as the broker assume full responsibility for the value of the cargo being transported in case of any damage, whether covered or not by the trucker's insurance. Any late pick ups or deliveries or no shows can result in charges that the broker will be responsible for. Any cancellation of this contract or no show, where we are required to find a truck elsewhere that results in additional charges or higher rates, will result in a charge back to the broker or trucker.";

// composed = one document of orders-compose-fo; carrier = the carrier's provider row (or null while not booked).
function bcRenderFO(composed, carrier, orderNumber){
  const doc = pdfDoc();
  pdfHeader(doc, 'Freight Order', 'FO-BT-' + btNum(orderNumber), CONTACT_EMAIL_FO);

  const X = 40, W = 532, PAD = 8, LABEL_H = 20, LINE_H = 13;
  const wrapLines = (lines, width) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
    return lines.filter(Boolean).flatMap(l => doc.splitTextToSize(String(l), width));
  };
  // One row of the grid: cells = [{ label, lines, span }]; spans share the 532 pt width, every cell of the row gets the height of the tallest.
  const row = (y, cells) => {
    const total = cells.reduce((n, c) => n + (c.span || 1), 0);
    let x = X;
    const laid = cells.map(c => {
      const w = W * (c.span || 1) / total;
      const lines = wrapLines(c.lines, w - PAD * 2);
      const cell = { ...c, x, w, lines };
      x += w;
      return cell;
    });
    const h = Math.max(40, LABEL_H + Math.max(...laid.map(c => c.lines.length)) * LINE_H + 6);
    doc.setDrawColor(205, 216, 230); doc.setLineWidth(0.75);
    laid.forEach(c => {
      doc.rect(c.x, y, c.w, h);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(30, 106, 219);
      doc.text(c.label, c.x + PAD, y + 14);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(15, 31, 51);
      c.lines.forEach((l, i) => doc.text(l, c.x + PAD, y + LABEL_H + 8 + i * LINE_H));
    });
    return y + h;
  };

  const phone = (p) => p ? ['T: ' + p] : [];
  let y = 148;
  y = row(y, [
    { label: 'ISSUE DATE', lines: [todayStr()] },
    { label: 'PU DATE', lines: [fmtDateStr(composed.pick_up_date) || 'TBD'] },
    { label: 'DELIVERY DATE', lines: [fmtDateStr(composed.delivery_date) || 'TBD'] },
  ]);
  y = row(y, [
    { label: 'VENDOR', lines: [carrier ? carrier.name : 'TBD — not yet booked', carrier && carrier.contact_name, carrier && carrier.phone] },
    { label: 'CLIENT NAME', lines: ['BuenTrade LLC'] },
  ]);
  y = row(y, [
    { label: 'PICK UP ADDRESS', lines: [...composed.pick_up_lines, ...phone(composed.pick_up_phone)] },
    { label: 'DELIVERY ADDRESS', lines: [...composed.delivery_lines, ...phone(composed.delivery_phone)] },
  ]);
  y = row(y, [
    { label: 'STOP OVER (IF NECESSARY)', lines: ['NA'] },
    { label: 'APPT. / CHECK IN #', lines: ['TBD'] },
    { label: 'RELEASE #', lines: [composed.release_number || 'TBD'] },
  ]);
  y = row(y, [
    { label: 'TEMPERATURE SETTING', lines: [composed.temperature_setting || 'Confirm with plant'] },
    { label: 'ESTIMATED WEIGHT', lines: [composed.weight ? composed.weight.toLocaleString('en-US') + ' lbs' : 'TBD'] },
    { label: 'CLIENT ORDER #', lines: ['FO-BT-' + btNum(orderNumber)] },
  ]);
  y = row(y, [{ label: 'PRODUCT / COMMODITY', lines: [composed.product_name || '—'] }]);

  doc.autoTable({
    startY: y + 10,
    head: [['Service Purchased', 'Amount']],
    body: [['Inland Freight', '$' + (composed.rate || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })]],
    theme: 'grid',
    headStyles: { fillColor: [30, 106, 219], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
    styles: { fontSize: 9.5, cellPadding: 6, lineColor: [205, 216, 230] },
    columnStyles: { 1: { cellWidth: 130, halign: 'right' } },
    margin: { left: X, right: X },
  });

  const section = (top, title, text) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(30, 106, 219);
    doc.text(title, X, top);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(100, 110, 125);
    const t = doc.splitTextToSize(text, W - 8);
    doc.text(t, X, top + 12);
    return top + 12 + t.length * 9.5 + 9;
  };
  let ty = doc.lastAutoTable.finalY + 18;
  ty = section(ty, 'PICK UP INSTRUCTIONS', FO_PICKUP_INSTRUCTIONS);
  ty = section(ty, 'DELIVERY INSTRUCTIONS', FO_DELIVERY_INSTRUCTIONS);
  ty = section(ty, 'IMPORTANT NOTICE', FO_IMPORTANT_NOTICE);
  // A rate confirmation is signed by the carrier before dispatch.
  pdfSignatureBlock(doc, ty + 6, 'Authorized by — BuenTrade LLC', 'Accepted by — Carrier / Dispatch');
  pdfFooter(doc, 'en');
  return doc;
}
