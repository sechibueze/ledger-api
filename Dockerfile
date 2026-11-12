FROM node:22-alpine

# Prisma's schema engine, which the migrate deploy uses needs openssl on alpine
RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# The generated client is gitignored, so it has to be built here.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

ENV NODE_ENV=production
EXPOSE 4010

CMD ["npm", "start"]