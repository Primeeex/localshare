FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
VOLUME ["/app/uploads"]
ENTRYPOINT ["node", "bin/localshare.js"]
CMD ["--dir", "/app/uploads"]
