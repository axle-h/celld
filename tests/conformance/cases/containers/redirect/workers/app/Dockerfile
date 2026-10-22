FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
COPY reply.sh /reply.sh
RUN chmod +x /reply.sh
EXPOSE 8080
CMD ["nc", "-lk", "-p", "8080", "-e", "/reply.sh"]
