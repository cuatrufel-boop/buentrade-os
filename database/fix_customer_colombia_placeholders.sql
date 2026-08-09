-- These two are obvious fake/placeholder numbers (all same repeated digit), not real data.
-- Clearing so the WhatsApp button just won't show until a real number is entered.
update customers set phone = null where id = 'cfae5911-d9c7-4e2c-a511-2cff0b22f130'; -- Jule Global T&C SAS (was +57 55555555)
update customers set phone = null where id = 'ab655b3f-b2d8-437b-bdf4-a3f9a89a4bb0'; -- Productos Carnicos y Alimenticios Don Vitto (was +57 555555555)
