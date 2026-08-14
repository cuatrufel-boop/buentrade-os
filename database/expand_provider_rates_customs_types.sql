-- BUENTRADE Trading OS — split the generic 'customs' bucket into the 4
-- real line items providers actually quote separately (matching the
-- fields already built in trading-tool.html's Direct Costs: Trámite
-- aduanal, Bodega americana, Lumper fee, INBOND Release). Keeps 'customs'
-- too, as a fallback for a provider who only gives one lump import price.

alter table provider_rates drop constraint provider_rates_service_type_check;

alter table provider_rates add constraint provider_rates_service_type_check
  check (service_type in (
    'us_freight', 'mexican_freight', 'customs',
    'tramite_aduanal', 'bodega_americana', 'lumper_fee', 'inbond_release'
  ));
