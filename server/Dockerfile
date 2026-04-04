FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

EXPOSE 4000

ENV PORT=4000
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
