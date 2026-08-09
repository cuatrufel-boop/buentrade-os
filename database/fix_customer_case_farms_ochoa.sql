-- Case Farms (customer): country was mislabeled Andorra, should be United States.
-- Matches the plants.Case Farms row (already fixed earlier). Also add the missing '+'.
update customers set country = 'United States', phone = '+1 7045284501'
where id = 'd500c90f-c118-4b03-ad3e-0ba7b6b7b5f4';

-- Comercializadora de Alimentos Ochoa: user confirmed correct number is +52 664 218 1980
-- (stored value had an extra stray digit).
update customers set phone = '+526642181980'
where id = '1752b5ac-a922-4943-a0a0-3075851ad652';
