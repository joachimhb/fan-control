FROM node:15-stretch
# FROM node:13-stretch

# ##############################################################################
# Install all the base packages needed for the following installs
# Set up timezone

ENV DEBIAN_FRONTEND noninteractive

RUN apt-get update
RUN apt-get install -y apt-utils
RUN apt-get upgrade -y

RUN apt-get install -y curl

RUN \
  apt-get install -y \
    curl \
    dnsutils \
    locales \
    sudo \
    unzip \
    wget \
    xz-utils \
    python \
    vim

RUN \
  cp /usr/share/zoneinfo/Europe/Berlin /etc/localtime && \
  echo "Europe/Berlin" > /etc/timezone && \
  sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen && \
  locale-gen && \
  dpkg-reconfigure locales && \
  /sbin/ldconfig

ENV LANG en_US.UTF-8
ENV LANGUAGE en_US.UTF-8
ENV LC_ALL en_US.UTF-8

WORKDIR /source

# ##############################################################################
# Install pigpio from http://abyz.me.uk/rpi/pigpio/index.html

ARG PIGPIO_VERSION=72
RUN \
  apt-get install -y \
    gcc \
    make \
    musl-dev

RUN wget -v https://github.com/joan2937/pigpio/archive/V$PIGPIO_VERSION.zip
RUN unzip V$PIGPIO_VERSION
RUN cd pigpio-$PIGPIO_VERSION && \
  /bin/cat Makefile | sed 's/ldconfig//' > Makefile.tmp && \
  mv Makefile.tmp Makefile && \
  make && \
  make install

COPY . /app

WORKDIR /app
RUN npm install --production

ENV LD_LIBRARY_PATH /usr/local/lib/

CMD ["/usr/local/bin/node", "/app/fan-control.js"]
