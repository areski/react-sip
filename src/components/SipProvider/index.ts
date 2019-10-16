import * as JsSIP from "jssip";
import * as PropTypes from "prop-types";
import * as React from "react";
import dummyLogger from "../../lib/dummyLogger";
import {
  CALL_DIRECTION_INCOMING,
  CALL_DIRECTION_OUTGOING,
  CALL_STATUS_ACTIVE,
  CALL_STATUS_IDLE,
  CALL_STATUS_STARTING,
  CALL_STATUS_STOPPING,
  SIP_ERROR_TYPE_CONFIGURATION,
  SIP_ERROR_TYPE_CONNECTION,
  SIP_ERROR_TYPE_REGISTRATION,
  SIP_STATUS_CONNECTED,
  SIP_STATUS_CONNECTING,
  SIP_STATUS_DISCONNECTED,
  SIP_STATUS_ERROR,
  SIP_STATUS_REGISTERED,
} from "../../lib/enums";
import {
  CallDirection,
  CallStatus,
  SipErrorType,
  SipStatus,
} from "../../lib/enums";
import {
  callPropType,
  ExtraHeaders,
  extraHeadersPropType,
  IceServers,
  iceServersPropType,
  sipPropType,
} from "../../lib/types";

export default class SipProvider extends React.Component<
  {
    host: string;
    port: number;
    pathname: string;
    user: string;
    password: string;
    autoRegister: boolean;
    autoAnswer: boolean;
    iceRestart: boolean;
    sessionTimersExpires: number;
    extraHeaders: ExtraHeaders;
    iceServers: IceServers;
    debug: boolean;
    incomingAudioDeviceId: string;
    outboundAudioDeviceId: string;
  },
  {
    sipStatus: SipStatus;
    sipErrorType: SipErrorType | null;
    sipErrorMessage: string | null;
    callStatus: CallStatus;
    callDirection: CallDirection | null;
    callCounterpart: string | null;
    dtmfSender: RTCDTMFSender | null;
    callIsOnHold: boolean;
    callMicrophoneIsMuted: boolean;
    rtcSession;
  }
> {
  public static childContextTypes = {
    sip: sipPropType,
    call: callPropType,
    registerSip: PropTypes.func,
    unregisterSip: PropTypes.func,

    answerCall: PropTypes.func,
    startCall: PropTypes.func,
    stopCall: PropTypes.func,
    sendDTMF: PropTypes.func,
  };

  public static propTypes = {
    host: PropTypes.string,
    port: PropTypes.number,
    pathname: PropTypes.string,
    user: PropTypes.string,
    password: PropTypes.string,
    autoRegister: PropTypes.bool,
    autoAnswer: PropTypes.bool,
    iceRestart: PropTypes.bool,
    sessionTimersExpires: PropTypes.number,
    extraHeaders: extraHeadersPropType,
    iceServers: iceServersPropType,
    debug: PropTypes.bool,
    incomingAudioDeviceId: PropTypes.string,
    outboundAudioDeviceId: PropTypes.string,

    children: PropTypes.node,
  };

  public static defaultProps = {
    host: null,
    port: null,
    pathname: "",
    user: null,
    password: null,
    autoRegister: true,
    autoAnswer: false,
    iceRestart: false,
    sessionTimersExpires: 120,
    extraHeaders: { register: [], invite: [], hold: [] },
    iceServers: [],
    debug: false,
    incomingAudioDeviceId: "",
    outboundAudioDeviceId: "",

    children: null,
  };
  private ua;
  private remoteAudio;
  private logger;

  constructor(props) {
    super(props);

    this.state = {
      sipStatus: SIP_STATUS_DISCONNECTED,
      sipErrorType: null,
      sipErrorMessage: null,

      rtcSession: null,
      // errorLog: [],
      callStatus: CALL_STATUS_IDLE,
      callDirection: null,
      callCounterpart: null,
      dtmfSender: null,
      callIsOnHold: false,
      callMicrophoneIsMuted: false,
    };

    this.ua = null;
  }

  public getChildContext() {
    return {
      sip: {
        ...this.props,
        status: this.state.sipStatus,
        errorType: this.state.sipErrorType,
        errorMessage: this.state.sipErrorMessage,
      },
      call: {
        id: "??",
        status: this.state.callStatus,
        direction: this.state.callDirection,
        counterpart: this.state.callCounterpart,
        dtmfSender: this.state.dtmfSender,
        isOnHold: this.state.callIsOnHold,
        hold: this.callHold,
        unhold: this.callUnhold,
        toggleHold: this.callToggleHold,
        microphoneIsMuted: this.state.callMicrophoneIsMuted,
        muteMicrophone: this.callMuteMicrophone,
        unmuteMicrophone: this.callUnmuteMicrophone,
        toggleMuteMicrophone: this.callToggleMuteMicrophone,
      },
      registerSip: this.registerSip,
      unregisterSip: this.unregisterSip,

      answerCall: this.answerCall,
      startCall: this.startCall,
      stopCall: this.stopCall,
      sendDTMF: this.sendDTMF,
    };
  }

  public componentDidMount() {
    if (window.document.getElementById("sip-provider-audio")) {
      throw new Error(
        `Creating two SipProviders in one application is forbidden. If that's not the case ` +
          `then check if you're using "sip-provider-audio" as id attribute for any existing ` +
          `element`,
      );
    }

    this.remoteAudio = window.document.createElement("audio");
    this.remoteAudio.id = "sip-provider-audio";
    window.document.body.appendChild(this.remoteAudio);

    this.reconfigureDebug();
    this.reinitializeJsSIP();
  }

  public componentDidUpdate(prevProps) {
    if (this.props.debug !== prevProps.debug) {
      this.reconfigureDebug();
    }
    if (
      this.props.host !== prevProps.host ||
      this.props.port !== prevProps.port ||
      this.props.pathname !== prevProps.pathname ||
      this.props.user !== prevProps.user ||
      this.props.password !== prevProps.password ||
      this.props.autoRegister !== prevProps.autoRegister ||
      this.props.incomingAudioDeviceId !== prevProps.incomingAudioDeviceId ||
      this.props.outboundAudioDeviceId !== prevProps.outboundAudioDeviceId
    ) {
      this.reinitializeJsSIP();
    }
  }

  public componentWillUnmount() {
    this.remoteAudio.parentNode.removeChild(this.remoteAudio);
    delete this.remoteAudio;
    if (this.ua) {
      this.ua.stop();
      this.ua = null;
    }
  }

  public registerSip = () => {
    if (this.props.autoRegister) {
      throw new Error(
        "Calling registerSip is not allowed when autoRegister === true",
      );
    }
    if (this.state.sipStatus !== SIP_STATUS_CONNECTED) {
      throw new Error(
        `Calling registerSip is not allowed when sip status is ${
          this.state.sipStatus
        } (expected ${SIP_STATUS_CONNECTED})`,
      );
    }
    return this.ua.register();
  };

  public unregisterSip = () => {
    if (this.props.autoRegister) {
      throw new Error(
        "Calling registerSip is not allowed when autoRegister === true",
      );
    }
    if (this.state.sipStatus !== SIP_STATUS_REGISTERED) {
      throw new Error(
        `Calling unregisterSip is not allowed when sip status is ${
          this.state.sipStatus
        } (expected ${SIP_STATUS_CONNECTED})`,
      );
    }
    return this.ua.unregister();
  };

  public answerCall = () => {
    if (
      this.state.callStatus !== CALL_STATUS_STARTING ||
      this.state.callDirection !== CALL_DIRECTION_INCOMING
    ) {
      throw new Error(
        `Calling answerCall() is not allowed when call status is ${
          this.state.callStatus
        } and call direction is ${
          this.state.callDirection
        }  (expected ${CALL_STATUS_STARTING} and ${CALL_DIRECTION_INCOMING})`,
      );
    }

    this.state.rtcSession.answer({
      mediaConstraints: {
        audio: true,
        video: false,
      },
      pcConfig: {
        iceServers: this.props.iceServers,
      },
    });
  };

  public startCall = (destination) => {
    if (!destination) {
      throw new Error(`Destination must be defined (${destination} given)`);
    }
    if (
      this.state.sipStatus !== SIP_STATUS_CONNECTED &&
      this.state.sipStatus !== SIP_STATUS_REGISTERED
    ) {
      throw new Error(
        `Calling startCall() is not allowed when sip status is ${
          this.state.sipStatus
        } (expected ${SIP_STATUS_CONNECTED} or ${SIP_STATUS_REGISTERED})`,
      );
    }

    if (this.state.callStatus !== CALL_STATUS_IDLE) {
      throw new Error(
        `Calling startCall() is not allowed when call status is ${
          this.state.callStatus
        } (expected ${CALL_STATUS_IDLE})`,
      );
    }

    const { iceServers, sessionTimersExpires } = this.props;
    const extraHeaders = this.props.extraHeaders.invite;

    const options = {
      extraHeaders,
      mediaConstraints: { audio: true, video: false },
      rtcOfferConstraints: { iceRestart: this.props.iceRestart },
      pcConfig: {
        iceServers,
      },
      sessionTimersExpires,
    };

    this.ua.call(destination, options);
    this.setState({ callStatus: CALL_STATUS_STARTING });
  };

  public stopCall = () => {
    this.setState({ callStatus: CALL_STATUS_STOPPING });

    // Close senders, as these keep the microphone open according to browsers (and that keeps Bluetooth headphones from exiting headset mode)
    this.state.rtcSession.connection.getSenders().forEach((sender) => {
      sender.track.stop();
    });

    this.ua.terminateSessions();
  };

  public sendDTMF = (tones, duration = 100, interToneGap = 70) => {
    if (
      this.state.callStatus === "callStatus/ACTIVE" &&
      this.state.dtmfSender
    ) {
      this.state.dtmfSender.insertDTMF(tones, duration, interToneGap);
    } else {
      this.logger.debug(
        "Warning:",
        "You are attempting to send DTMF, but there is no active call.",
      );
    }
  };

  public reconfigureDebug() {
    const { debug } = this.props;

    if (debug) {
      JsSIP.debug.enable("JsSIP:*");
      this.logger = console;
    } else {
      JsSIP.debug.disable("JsSIP:*");
      this.logger = dummyLogger;
    }
  }

  public reinitializeJsSIP() {
    if (this.ua) {
      this.ua.stop();
      this.ua = null;
    }

    const {
      host,
      port,
      pathname,
      user,
      password,
      autoRegister,
      incomingAudioDeviceId,
      outboundAudioDeviceId,
    } = this.props;

    if (!host || !port || !user) {
      this.setState({
        sipStatus: SIP_STATUS_DISCONNECTED,
        sipErrorType: null,
        sipErrorMessage: null,
      });
      return;
    }

    if (incomingAudioDeviceId) {
      this.remoteAudio.setSinkId(incomingAudioDeviceId);
    }

    try {
      const socket = new JsSIP.WebSocketInterface(
        `wss://${host}:${port}${pathname}`,
      );
      this.ua = new JsSIP.UA({
        uri: `sip:${user}@${host}`,
        password,
        sockets: [socket],
        register: autoRegister,
      });
    } catch (error) {
      this.logger.debug("Error", error.message, error);
      this.setState({
        sipStatus: SIP_STATUS_ERROR,
        sipErrorType: SIP_ERROR_TYPE_CONFIGURATION,
        sipErrorMessage: error.message,
      });
      return;
    }

    const { ua } = this;
    ua.on("connecting", () => {
      this.logger.debug('UA "connecting" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_CONNECTING,
        sipErrorType: null,
        sipErrorMessage: null,
      });
    });

    ua.on("connected", () => {
      this.logger.debug('UA "connected" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_CONNECTED,
        sipErrorType: null,
        sipErrorMessage: null,
      });
    });

    ua.on("disconnected", () => {
      this.logger.debug('UA "disconnected" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_ERROR,
        sipErrorType: SIP_ERROR_TYPE_CONNECTION,
        sipErrorMessage: "disconnected",
      });
    });

    ua.on("registered", (data) => {
      this.logger.debug('UA "registered" event', data);
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_REGISTERED,
        callStatus: CALL_STATUS_IDLE,
      });
    });

    ua.on("unregistered", () => {
      this.logger.debug('UA "unregistered" event');
      if (this.ua !== ua) {
        return;
      }
      if (ua.isConnected()) {
        this.setState({
          sipStatus: SIP_STATUS_CONNECTED,
          callStatus: CALL_STATUS_IDLE,
          callDirection: null,
        });
      } else {
        this.setState({
          sipStatus: SIP_STATUS_DISCONNECTED,
          callStatus: CALL_STATUS_IDLE,
          callDirection: null,
        });
      }
    });

    ua.on("registrationFailed", (data) => {
      this.logger.debug('UA "registrationFailed" event');
      if (this.ua !== ua) {
        return;
      }
      this.setState({
        sipStatus: SIP_STATUS_ERROR,
        sipErrorType: SIP_ERROR_TYPE_REGISTRATION,
        sipErrorMessage: data,
      });
    });

    ua.on(
      "newRTCSession",
      ({ originator, session: rtcSession, request: rtcRequest }) => {
        if (!this || this.ua !== ua) {
          return;
        }

        // identify call direction
        if (originator === "local") {
          const foundUri = rtcRequest.to.toString();
          const delimiterPosition = foundUri.indexOf(";") || null;
          this.setState({
            callDirection: CALL_DIRECTION_OUTGOING,
            callStatus: CALL_STATUS_STARTING,
            callCounterpart:
              foundUri.substring(0, delimiterPosition) || foundUri,
            callIsOnHold: rtcSession.isOnHold().local,
            callMicrophoneIsMuted: rtcSession.isMuted().audio,
          });
        } else if (originator === "remote") {
          const foundUri = rtcRequest.from.toString();
          const delimiterPosition = foundUri.indexOf(";") || null;
          this.setState({
            callDirection: CALL_DIRECTION_INCOMING,
            callStatus: CALL_STATUS_STARTING,
            callCounterpart:
              foundUri.substring(0, delimiterPosition) || foundUri,
            callIsOnHold: rtcSession.isOnHold().local,
            callMicrophoneIsMuted: rtcSession.isMuted().audio,
          });
        }

        const { rtcSession: rtcSessionInState } = this.state;

        // Avoid if busy or other incoming
        if (rtcSessionInState) {
          this.logger.debug('incoming call replied with 486 "Busy Here"');
          rtcSession.terminate({
            status_code: 486,
            reason_phrase: "Busy Here",
          });
          return;
        }

        this.setState({ rtcSession });
        rtcSession.on("failed", () => {
          if (this.ua !== ua) {
            return;
          }

          this.setState({
            rtcSession: null,
            callStatus: CALL_STATUS_IDLE,
            callDirection: null,
            callCounterpart: null,
            dtmfSender: null,
            callMicrophoneIsMuted: false,
          });
        });

        rtcSession.on("ended", () => {
          if (this.ua !== ua) {
            return;
          }

          // Close senders, as these keep the microphone open according to browsers (and that keeps Bluetooth headphones from exiting headset mode)
          this.state.rtcSession.connection.getSenders().forEach((sender) => {
            sender.track.stop();
          });

          this.setState({
            rtcSession: null,
            callStatus: CALL_STATUS_IDLE,
            callDirection: null,
            callCounterpart: null,
            callIsOnHold: false,
            dtmfSender: null,
            callMicrophoneIsMuted: false,
          });
        });

        rtcSession.on("accepted", () => {
          if (this.ua !== ua) {
            return;
          }

          // Set outbound device, if provided
          if (outboundAudioDeviceId) {
            // Get the appropriate device and set the new stream
            const constraints = {
              audio: {
                deviceId: {
                  exact: outboundAudioDeviceId,
                },
              },
            };
            navigator.mediaDevices
              .getUserMedia(constraints)
              .then((stream) => {
                rtcSession.connection
                  .getRemoteStreams()
                  .forEach((remoteStream) => {
                    rtcSession.connection.removeStream(remoteStream);
                  });
                rtcSession.connection.addStream(stream);
              })
              .catch((e) => {
                this.logger.warn(
                  "Warning: Invalid audio device passed. Caught error:",
                );
                this.logger.warn(e);
              });
          }

          [
            this.remoteAudio.srcObject,
          ] = rtcSession.connection.getRemoteStreams();

          // Set up DTMF
          this.setState({
            dtmfSender: rtcSession.connection.getSenders()[0].dtmf,
          });

          // const played = this.remoteAudio.play();
          const played = this.remoteAudio.play();

          if (typeof played !== "undefined") {
            played
              .catch(() => {
                /**/
              })
              .then(() => {
                setTimeout(() => {
                  this.remoteAudio.play();
                }, 2000);
              });
            // this.setState({ dtmfSender: rtcSession.connection.createDTMFSender(rtcSession.getAudioTracks()[0])});
            this.setState({ callStatus: CALL_STATUS_ACTIVE });
            return;
          }

          setTimeout(() => {
            this.remoteAudio.play();
          }, 2000);

          this.setState({ callStatus: CALL_STATUS_ACTIVE });
        });

        if (
          this.state.callDirection === CALL_DIRECTION_INCOMING &&
          this.props.autoAnswer
        ) {
          this.logger.log("Answer auto ON");
          this.answerCall();
        } else if (
          this.state.callDirection === CALL_DIRECTION_INCOMING &&
          !this.props.autoAnswer
        ) {
          this.logger.log("Answer auto OFF");
        } else if (this.state.callDirection === CALL_DIRECTION_OUTGOING) {
          this.logger.log("OUTGOING call");
        }
      },
    );

    const extraHeadersRegister = this.props.extraHeaders.register || [];
    if (extraHeadersRegister.length) {
      ua.registrator().setExtraHeaders(extraHeadersRegister);
    }
    ua.start();
  }

  public render() {
    return this.props.children;
  }

  private callHold = (useUpdate = false) => {
    const holdStatus = this.state.rtcSession.isOnHold();
    if (!holdStatus.local) {
      const options = {
        useUpdate,
        extraHeaders: this.props.extraHeaders.hold,
      };
      const done = () => {
        this.setState({ callIsOnHold: true });
      };
      this.state.rtcSession.hold(options, done);
    }
  };

  private callUnhold = (useUpdate = false) => {
    const holdStatus = this.state.rtcSession.isOnHold();
    if (holdStatus.local) {
      const options = {
        useUpdate,
        extraHeaders: this.props.extraHeaders.hold,
      };
      const done = () => {
        this.setState({ callIsOnHold: false });
      };
      this.state.rtcSession.unhold(options, done);
    }
  };

  private callToggleHold = (useUpdate = false) => {
    const holdStatus = this.state.rtcSession.isOnHold();
    return holdStatus.local
      ? this.callUnhold(useUpdate)
      : this.callHold(useUpdate);
  };

  private callMuteMicrophone = () => {
    if (this.state.rtcSession && !this.state.callMicrophoneIsMuted) {
      this.state.rtcSession.mute({ audio: true, video: false });
      this.setState({ callMicrophoneIsMuted: true });
    }
  };

  private callUnmuteMicrophone = () => {
    if (this.state.rtcSession && this.state.callMicrophoneIsMuted) {
      this.state.rtcSession.unmute({ audio: true, video: false });
      this.setState({ callMicrophoneIsMuted: false });
    }
  };

  private callToggleMuteMicrophone = () => {
    return this.state.callMicrophoneIsMuted
      ? this.callUnmuteMicrophone()
      : this.callMuteMicrophone();
  };
}
