-- ============================================================================
-- 20260927140000_business_types_seed.sql
--
-- The trader's own list of client business types (given 2026-09-27), in his order. name_es is his exact text; name_en
-- is what the (English) app shows; sort_order keeps his order everywhere.
-- ============================================================================
begin;
alter table business_types add column name_es text;
alter table business_types add column sort_order int;
insert into business_types (sort_order, name_en, name_es) values
  (1, 'Traditional Trade (convenience & grocery stores)',                   'Canal Tradicional (misceláneas, tiendas de abarrotes)'),
  (2, 'Specialty Butcher Shops (independent or neighborhood)',              'Carnicerías Especializadas (independientes o de barrio)'),
  (3, 'Retail / Supermarkets (self-service chains)',                        'Retail / Supermercados (cadenas de autoservicio)'),
  (4, 'Foodservice / HORECA (hotels, restaurants & catering)',              'Foodservice / HORECA (Hoteles, Restaurantes y Catering)'),
  (5, 'Institutional (industrial cafeterias, hospitals, schools, government)', 'Mercado Institucional (comedores industriales, hospitales, escuelas, gobierno)'),
  (6, 'Producer-Owned Stores / Direct Points of Sale',                      'Tiendas Propias de Productor / Puntos de Venta Directos'),
  (7, 'Public Markets & Wholesale Hubs (Centrales de Abasto)',              'Mercados Públicos y Centrales de Abasto'),
  (8, 'Processors & Agro-industrial Plants (B2B / raw material)',           'Procesadoras y Planta Agroindustrial (B2B / materia prima)');
commit;
