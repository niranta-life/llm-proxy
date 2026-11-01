FROM nginx:1.28-alpine
RUN apk add --no-cache openssl curl
COPY install-certs.sh /usr/local/bin/install-certs
COPY entrypoint.sh /entrypoint.sh
COPY reload-ingress.sh /usr/local/bin/reload-ingress
COPY check-certificate.sh /usr/local/bin/check-certificate
COPY check-ingress.sh /usr/local/bin/check-ingress
RUN chmod 755 /usr/local/bin/install-certs /entrypoint.sh /usr/local/bin/reload-ingress /usr/local/bin/check-certificate /usr/local/bin/check-ingress
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
