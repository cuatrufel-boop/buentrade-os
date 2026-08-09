-- Mexico customer phones: strip the old "1" trunk prefix after +52.
-- That prefix was required for old-style LADA international dialing but breaks
-- WhatsApp deep links (wa.me expects +52 followed directly by the 10-digit number).
-- Matched by exact customer id, not name.

update customers set phone = '+528110161038' where id = 'e91ac2d3-7e67-4110-8743-9b33008849ec'; -- El Norteño Especialidad en Carnes (was +52 18110161038)
update customers set phone = '+525510428907' where id = 'a3753f57-a699-4717-a13c-cc1a800de4f3'; -- Comercializadora de Carnes El Ranchito 7 (was +52 15510428907)
update customers set phone = '+522221141851' where id = 'f6f61855-a7e6-4fa1-a289-80dea5c484e3'; -- Protemeat Internacional (was +52 12221141851)
update customers set phone = '+528116605677' where id = '018d53a4-8c65-492a-be72-de0701de6c87'; -- Carnes Ramos (was +52 18116605677)
update customers set phone = '+523314086029' where id = '9fd7bd45-8058-48b4-8e93-e4e0b41c93da'; -- PRODUCTOS ALIMENTICIOS NASA (was +52 13314086029)
update customers set phone = '+528110447837' where id = '800dbd8d-6c5c-4776-87d4-c2aeefe1af6c'; -- Cardenas Alimentos (was +52 18110447837)
update customers set phone = '+525518804071' where id = 'ca9a237c-d95f-4410-9276-f7fc9d3afa4d'; -- Xalostoc SA de CV (was +52 15518804071)
update customers set phone = '+523333370690' where id = 'b29f5a29-5304-4f6f-aad3-49fd9f2a0018'; -- Jose Manuel Grey Parra (was +52 13333370690)
update customers set phone = '+525587911728' where id = '76564b7d-5df9-4270-b359-0ac66d4c34a3'; -- Rangel Garduño (was +52 15587911728)
update customers set phone = '+523313140761' where id = '37bc2bfd-2330-4914-9b83-c2e9344a7600'; -- Valvil (was +52 13313140761)
update customers set phone = '+525529556489' where id = 'fd8c4865-36bb-4291-a81a-2061164f5a70'; -- Comercializadora Nareci SA de CV (was 52 15529556489, also missing the +)
update customers set phone = '+526141960315' where id = '0935cbdb-3315-479c-8dcd-30f49b700be4'; -- Hermanos Jacquez Ochoa (was +52 16141960315)
update customers set phone = '+528119997838' where id = '8f54ff56-eb84-4e23-a879-0dbbbb48f7c9'; -- Comercializadora Yesaki SA (was +52 18119997838)
update customers set phone = '+528111893292' where id = 'dc09f024-8da5-4640-a7b6-d27433b6733d'; -- ECAGSA Carnes SA de CV (was +52 18111893292)
update customers set phone = '+528444149151' where id = '59df0224-7379-4672-8ec8-7cffc0e61a94'; -- Alanis Alimentos SA de CV (was +52 18444149151)
update customers set phone = '+528115993903' where id = 'd28d2c6a-69e5-4be4-bf9f-db6bf817ea0c'; -- Pollos Vidaurri SA de CV (was +52 18115993903)
update customers set phone = '+523336678056' where id = 'b81f5f87-98b9-4a23-8951-c1306b9afffa'; -- Chic & Chicken SA de CV (was +52 13336678056)
update customers set phone = '+522221688324' where id = '5ffbb388-538a-45b2-9297-676a49ee66ac'; -- Abastecedora de Carnes Frescas Roel, SA de CV (was +52 12221688324)
update customers set phone = '+524491557782' where id = 'f973e65d-ed17-4d50-b701-5d20923a516a'; -- Silver River Foods Inc (was +52 14491557782)
