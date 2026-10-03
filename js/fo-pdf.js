// The Freight Order PDF (the document the carrier receives), drawn once for every page that sends it (orders.html and offers.html), in the same
// layout as the Purchase Order: two address blocks per row, label / value rows, one blue-header table, then the instruction texts and signatures.
// Uses each page's own PDF helpers and constants (pdfDoc, pdfHeader, pdfInfoBlock, pdfKeyValueRows, pdfTerms, pdfSignatureBlock, pdfFooter,
// CONTACT_EMAIL_FO, btNum, fmtDateStr, todayStr), which both pages define identically.

const FO_PICKUP_INSTRUCTIONS = "Appointments must be made with the plant/cold storage facility 24-48 hours prior to pick up date. Only on trucks booked 24 hours prior to pick up are considered exceptions. If the facility is a first come first serve (FCFS), call 24-48 hours prior to make sure that the load is ready for pick up. We will not be responsible for any TONU if there is no confirmation that the plant advised the load was ready when it was not. Important: please take note of the employee confirming P/U information = email the same employee confirming the load is ready, time & date of pick up. For FCFS please have email confirming product is ready to be picked up on the set date.";
const FO_DELIVERY_INSTRUCTIONS = "USDA inspections - if this load needs USDA inspection at destination or an in transit point, the driver needs to check in before 6am at the inspection facility on the delivery or in transit date. Checking in after 6am can result in delays, possible layover and a late inspection fee of $150 USD which the driver will be responsible for.";
const FO_IMPORTANT_NOTICE = "All trucks must carry adequate insurance. You as the broker assume full responsibility for the value of the cargo being transported in case of any damage, whether covered or not by the trucker's insurance. Any late pick ups or deliveries or no shows can result in charges that the broker will be responsible for. Any cancellation of this contract or no show, where we are required to find a truck elsewhere that results in additional charges or higher rates, will result in a charge back to the broker or trucker.";

// composed = one document of orders-compose-fo; carrier = the carrier's provider row (or null while not booked).
function bcRenderFO(composed, carrier, orderNumber){
  const doc = pdfDoc();
  pdfHeader(doc, 'Freight Order', 'FO-BT-' + btNum(orderNumber), CONTACT_EMAIL_FO);

  const blockLook = { labelSize: 9.5, size: 10.5, lineH: 14, gap: 17 };
  const rowLook = { size: 9.5, step: 20, lineH: 12 };
  // pdfInfoBlock draws without saying where it ends: the bottom of a pair of blocks, from their wrapped lines.
  const blocksEnd = (y, ...blocks) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(blockLook.size);
    const n = Math.max(...blocks.map(lines => lines.filter(Boolean).reduce((k, l) => k + doc.splitTextToSize(String(l), 260).length, 0)));
    return y + blockLook.gap + n * blockLook.lineH;
  };
  const phone = (p) => p ? 'T: ' + p : null;

  let y = 172;
  const vendor = carrier ? [carrier.name, carrier.contact_name, carrier.phone] : ['TBD — not yet booked'];
  const client = ['BuenTrade LLC'];
  pdfInfoBlock(doc, 40, y, 'VENDOR', vendor, blockLook);
  pdfInfoBlock(doc, 320, y, 'CLIENT NAME', client, blockLook);
  y = blocksEnd(y, vendor, client) + 16;

  const pickUp = [...composed.pick_up_lines, phone(composed.pick_up_phone)];
  const delivery = [...composed.delivery_lines, phone(composed.delivery_phone)];
  pdfInfoBlock(doc, 40, y, 'PICK UP ADDRESS', pickUp, blockLook);
  pdfInfoBlock(doc, 320, y, 'DELIVERY ADDRESS', delivery, blockLook);
  y = blocksEnd(y, pickUp, delivery) + 20;

  const yLeft = pdfKeyValueRows(doc, 40, y, [
    ['ISSUE DATE', todayStr()],
    ['PU DATE', fmtDateStr(composed.pick_up_date) || 'TBD'],
    ['DELIVERY DATE', fmtDateStr(composed.delivery_date) || 'TBD'],
    ['CLIENT ORDER #', 'FO-BT-' + btNum(orderNumber)],
  ], rowLook);
  const yRight = pdfKeyValueRows(doc, 320, y, [
    ['TEMPERATURE SETTING', composed.temperature_setting || 'Confirm with plant'],
    ['RELEASE #', composed.release_number || 'TBD'],
    ['APPT. / CHECK IN #', 'TBD'],
    ['STOP OVER (IF NECESSARY)', 'NA'],
  ], rowLook);

  doc.autoTable({
    startY: Math.max(yLeft, yRight) + 8,
    head: [['Product / Commodity', 'Estimated Weight', 'Service Purchased', 'Amount']],
    body: [[
      composed.product_name || '—',
      composed.weight ? composed.weight.toLocaleString('en-US') + ' lbs' : 'TBD',
      'Inland Freight',
      '$' + (composed.rate || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }),
    ]],
    theme: 'grid',
    headStyles: { fillColor: [30, 106, 219], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 10 },
    styles: { fontSize: 10.5, cellPadding: { top: 9, bottom: 9, left: 7, right: 7 } },
    columnStyles: { 1: { cellWidth: 100 }, 2: { cellWidth: 104 }, 3: { cellWidth: 80 } },
    margin: { left: 40, right: 40 },
  });

  const termsLook = { titleSize: 9, size: 7.5, lineH: 9.5, gap: 13 };
  const texts = [['PICK UP INSTRUCTIONS', FO_PICKUP_INSTRUCTIONS], ['DELIVERY INSTRUCTIONS', FO_DELIVERY_INSTRUCTIONS], ['IMPORTANT NOTICE', FO_IMPORTANT_NOTICE]];
  doc.setFont('helvetica', 'normal'); doc.setFontSize(termsLook.size);
  const textsH = texts.reduce((h, [, t]) => h + termsLook.gap + doc.splitTextToSize(t, 532).length * termsLook.lineH, 0);
  // The signature line must stay at or above 714 so its "Date:" line clears the footer rule (758): when the table grows (a product name that
  // wraps), the gaps around the three texts shrink instead of the page running into the footer.
  const SIGNATURE_MAX_Y = 714, GAP_AFTER_TABLE = 22, GAP_BETWEEN = 12, GAP_BEFORE_SIGNATURE = 22;
  const gapsH = GAP_AFTER_TABLE + 2 * GAP_BETWEEN + GAP_BEFORE_SIGNATURE;
  const squeeze = Math.min(1, Math.max(0.3, (SIGNATURE_MAX_Y - doc.lastAutoTable.finalY - textsH) / gapsH));
  let ty = doc.lastAutoTable.finalY + GAP_AFTER_TABLE * squeeze;
  texts.forEach(([title, text], i) => {
    ty = pdfTerms(doc, ty, title, text, termsLook) - 22 + (i < texts.length - 1 ? GAP_BETWEEN : GAP_BEFORE_SIGNATURE) * squeeze;
  });
  // A rate confirmation is signed by the carrier before dispatch.
  pdfSignatureBlock(doc, ty, 'Authorized by — BuenTrade LLC', 'Accepted by — Carrier / Dispatch');
  pdfFooter(doc, 'en');
  return doc;
}
