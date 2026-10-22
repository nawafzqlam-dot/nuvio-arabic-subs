FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=7700
EXPOSE 7700
CMD ["node", "index.js"]
