-- Papas es un vegetal, no cerdo/pollo. "Vegetables" tampoco existe como
-- categoría válida en español -- se estandariza a "Vegetales".

update products set category = 'Vegetales', commercial_notes = null
where category = 'Cerdo y Pollo' and name = 'Papas';

update products set category = 'Vegetales'
where category = 'Vegetables';
