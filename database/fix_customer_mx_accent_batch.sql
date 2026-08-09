-- These 10 customers had country stored as "México" (with accent) instead of "Mexico",
-- so my first pass missed them. 8 also have the old "1" trunk prefix after +52 (same
-- issue as the first batch); 2 already had correct phone format, just need the country
-- spelling normalized to match the rest of the system.

update customers set phone = '+524442572620', country = 'Mexico' where id = '7c406aec-4673-4bf0-9748-6afeb81f7f87'; -- Carnicerias El Ingrato (was +52 14442572620)
update customers set phone = '+528117610854', country = 'Mexico' where id = '34de5dc5-e64f-49d0-8276-d5c5a4f67164'; -- Dist. de Carnes Int del Norte DYCINSA (was +52 18117610854)
update customers set phone = '+523312843485', country = 'Mexico' where id = '2c4bd9d9-e64e-4f56-a6be-4e9933341356'; -- PROCESADORA DE CARNES DON TIMO (was +52 13312843485)
update customers set phone = '+523314705807', country = 'Mexico' where id = '8410d115-1a0f-40cf-aaf7-e545c5d48507'; -- Carnytek SA de CV (was +52 13314705807)
update customers set phone = '+523521254249', country = 'Mexico' where id = '894a2ee8-1412-49f1-b941-e9c37fdf9a01'; -- Empacadora Bonnacarne SA de CV (was +52 13521254249)
update customers set phone = '+524424678466', country = 'Mexico' where id = 'f8b572ca-540d-4550-be87-96b0412465d8'; -- Aqua Terra Imports (was +52 14424678466)
update customers set phone = '+524446572607', country = 'Mexico' where id = '217a7e51-be56-4927-87ad-b6d6c44ce7f1'; -- La Blanquita (was +52 14446572607)
update customers set country = 'Mexico' where id = '36177bc6-5563-453f-af65-37b85d402d3d'; -- Abastecedora de carnes Los Corrales (phone already fine: +52 6181064543)
update customers set phone = '+525533358201', country = 'Mexico' where id = '722c6bca-784e-4dc5-9466-43ce82c93a71'; -- Empacadora Murgati SA de CV (was +52 15533358201)
update customers set country = 'Mexico' where id = 'b605fbfd-4d85-4346-b5a6-7da2840496b5'; -- Productos Neza (phone already fine: +52 5554380390)
