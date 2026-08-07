-- Corrección de datos reales de clientes (2026-08-07):
-- El "40" del Excel original era el colchón financiero interno de la
-- calculadora, no el plazo de pago real del cliente. El plazo real
-- (desde el cual empieza a correr la cobranza de cada factura) es 30
-- días para todos. Solo Murgati recibe entregado en destino (México);
-- el resto recibe en frontera (Border).

update customers set payment_days = 30;

update customers set usual_delivery_type = 'Delivered Mexico'
where trade_name = 'Empacadora Murgati SA de CV';

update customers set usual_delivery_type = 'Border'
where trade_name <> 'Empacadora Murgati SA de CV';
