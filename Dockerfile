FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --registry=https://registry.npmjs.org
COPY server.js ./
ENV NODE_ENV=production
EXPOSE 5000
CMD ["node", "server.js"]
