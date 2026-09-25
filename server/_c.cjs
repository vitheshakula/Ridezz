const { PrismaClient } = require('@prisma/client'); const p = new PrismaClient();
p.user.count({ where: { email: 'not.on.the.list@gmail.com' } }).then(n => { console.log(n === 0 ? 'no row created (good)' : 'ROW CREATED (bad)'); return p.$disconnect(); });
