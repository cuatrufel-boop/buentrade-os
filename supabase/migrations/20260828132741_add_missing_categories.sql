-- Adds the 3 categories confirmed real and in use by products.html's CATEGORY_EN map
-- (Pavo/Turkey, Vegetales/Vegetables, Marrana/Sow) that migration 005 missed — found only by
-- actually reading the real frontend, not by design review. Additive only.

insert into categories (name, name_en) values
  ('Pavo', 'Turkey'),
  ('Vegetales', 'Vegetables'),
  ('Marrana', 'Sow');
