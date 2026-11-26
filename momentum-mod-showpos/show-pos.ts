import { PanelHandler } from 'util/module-helpers';
import { CustomizerPropertyType, registerHUDCustomizerComponent } from 'common/hud-customizer';
import { getTextShadowFast } from 'common/hud-customizer';

//Enable cl_showpos through the Panorama API to expose player position coordinates through the HUD
 GameInterfaceAPI.ConsoleCommand('cl_showpos 1');

//The following transmission settings were selected through benchmarking to balance throughput and frame synchronization latency
//Set collection interval to 0 so we can collect telemetry as frequently as Panorama's scheduler allows
const COLLECTION_INTERVAL_SECONDS = 0;
//Samples are sent in batches of 5, with a maximum wait of 5ms before sending an incomplete batch
const BATCH_SIZE = 5;
const MAX_BATCH_WAIT_MS = 5;
//The queue is limited to 50 samples to prevent unbounded memory growth
const MAX_QUEUE_SIZE = 50;
//Allow up to 15 HTTP requests to increase transmission throughput
const MAX_CONCURRENT_REQUESTS = 15;
//Track the number of HTTP requests currently in progress
let activeRequests = 0;
//Temporarily store collected telemetry samples until they are ready to be transmitted to the server
let telemetryQueue = [];


const ServerPost = () => {
    //Record the start time of telemetry collection for synchronization with captured frames
    const collectionTimestampMs = Date.now();

//Initialize position as null because the position may be unavailable in certain states such as during map selection
//A valid position is assigned once it has been successfully extracted from the HUD
let position = null;

//Get the current UI context panel and its child panels to locate the cl_showpos display
const cp = $.GetContextPanel();
const children = cp.Children();

//Locate the panel containing the cl_showpos position display
if (children.length > 0) {
    const showPosPanel = children[0];
    const labels = showPosPanel.Children();

    //This panel structure was identified through testing
    //The first label contains the player position (labels[0])
    //The second label contains the view angle (labels[1])
    if (labels.length > 0) {
        const posLabel = labels[0] as Label;

        //Verify that the label exists and contains the expected position prefix
        if (posLabel && posLabel.text.startsWith('Pos:')) {
            //Remove "Pos:" prefix and split the remaining position string into individual values
            //Each value is then converted from a string into a number
            //Example "Pos: 100 200 300" will then become [100, 200, 300]
            const values = posLabel.text
                .replace('Pos:', '')
                .trim()
                .split(/\s+/)
                .map(Number);

            //Accept the position only if we receive exactly 3 valid numbers, then assign the values at each index to X, Y, and Z
            if (values.length === 3 && values.every(Number.isFinite)) {
                position = {
                    x: values[0],
                    y: values[1],
                    z: values[2]
                };
            }
        }
    }
}


    //Collect the player's current movement state
    const angles = MomentumPlayerAPI.GetAngles();
    const velocity = MomentumPlayerAPI.GetVelocity();
    const energy = MomentumPlayerAPI.GetEnergy();
    const wishVel = MomentumMovementAPI.GetMoveHudData().wishVel;
    const ducking = MomentumPlayerAPI.IsDucking();
    const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z);

    //Collect timer, game time, segment, checkpoint and tick interval information
    const timer = MomentumTimerAPI.GetObservedTimerStatus();
    const runTimer = timer.runTime;
    const gameTime = MomentumMovementAPI.GetCurrentTime();
    const majorNum = timer.majorNum;
    const minorNum =timer.minorNum;
    const segmentsCount = timer.segmentsCount;
    const segmentCheckpointsCount  = timer.segmentCheckpointsCount;
    const tickInterval = MomentumMovementAPI.GetTickInterval();

    //Collect statistics from the player's previous movement tick 
    const lastTick = MomentumMovementAPI.GetLastTickStats();

    //Collect additional movement and game state
    const physicalButtons = MomentumInputAPI.GetButtons().physicalButtons;
    const moveType = MomentumMovementAPI.GetMoveType();
    const mapName = MapCacheAPI.GetMapName();

    //Combine all the collected player/game information into a single sample
    //This object will be serialized into JSON before being sent to the local server
    const data = {
    timestampMs: collectionTimestampMs,
    runTime: runTimer,
    position: position,
    angles: angles,
    velocity: velocity,
    speed: speed,
    energy: energy,
    wishVel: wishVel,
    gameTime: gameTime,
    majorNum: majorNum,
    minorNum: minorNum,
    segmentsCount: segmentsCount,
    segmentCheckpointsCount: segmentCheckpointsCount,
    lastTick: lastTick,
    ducking: ducking,
    moveType: moveType,
    tickInterval: tickInterval,
    mapName: mapName,
    physicalButtons: physicalButtons
};

//Prevent telemetry queue from growing beyond its configured max size
//If the queue is full then discard the oldest sample to make room for newest data, prioritizing recent player information
if (telemetryQueue.length >= MAX_QUEUE_SIZE) {
    telemetryQueue.shift();
}
//Store telemetry sample alongside the time it entered the queue
//The queue timestamp is used to enforce the maximum batching delay
telemetryQueue.push({
    data: data,
    queuedAtMs: Date.now()
});
};

//Transmit queued telemetry sample to local server in batches
//This allows for reduced HTTP request overhead by transmitting multiple telemetry samples in a single request 
//Multiple requests can remain active simultaneously to increase transmission throughput
const sendBatch = () => {
    //Continue transmitting while there is available request capacity and queued telemetry
    while (
        activeRequests < MAX_CONCURRENT_REQUESTS &&
        telemetryQueue.length > 0
    ) {
        const oldestQueuedAtMs = telemetryQueue[0].queuedAtMs;
        //Check whether the oldest queued sample has exceeded the maximum allowed batching delay
        //If not enough samples have accumulated then wait briefly for additional samples
        //Once max wait reached we send the available samples
        const batchExpired =
            Date.now() - oldestQueuedAtMs >= MAX_BATCH_WAIT_MS;

        if (
            telemetryQueue.length < BATCH_SIZE &&
            !batchExpired
        ) {
            return;
        }
        //Remove up to BATCH_SIZE samples from the queue to create the next batch
        //splice() removes the sample from the queue so they cannot be included in another request
        const queuedBatch = telemetryQueue.splice(0, BATCH_SIZE);
        const batch = queuedBatch.map(item => item.data);
        //Increment the active request counter before transmission ensuring the configured max number of concurrent HTTP request limit is enforced
        activeRequests++;

        //Send the telemetry batch to the local Node.js server using an HTTP POST request
        //Convert the batch into JSON so the server can parse and process the samples
        $.AsyncWebRequest('http://127.0.0.1:8080/batch', {
            type: 'POST',
            data: {
                payload: JSON.stringify(batch)
            },
            //When request completes we decrement the active request counter and attempt to send next queued batch
            success: () => {
                activeRequests--;
                sendBatch();
            },
            //If transmission fails release the request and continue processing the remaining queue
            //The failed batch is not retried so its samples are discarded
            error: () => {
                activeRequests--;
                sendBatch();
            }
        } as any);
    }
};

//Main telemetry loop which continuously collects telemetry, attempts to transmit queued samples and schedules the next collection cycle 
 const requestLoop = () => {

    ServerPost();

    sendBatch();

    $.Schedule(COLLECTION_INTERVAL_SECONDS, requestLoop);
};

// Start telemetry collection loop
requestLoop();

@PanelHandler()
class HudShowPosHandler {
	constructor() {
		registerHUDCustomizerComponent($.GetContextPanel(), {
			name: $.Localize('#Customizer_Show_Pos_Name'),
			resizeX: true,
			resizeY: false,
			dynamicStyles: {
				fontStyling: {
					name: $.Localize('#Customizer_FontStyling'),
					type: CustomizerPropertyType.NONE,
					expandable: true,
					children: [{ styleID: 'font' }, { styleID: 'fontSize' }, { styleID: 'fontColor' }]
				},
				font: {
					name: $.Localize('#Customizer_Font'),
					type: CustomizerPropertyType.FONT_PICKER,
					targetPanel: '.showpos-entry__label',
					styleProperty: 'fontFamily',
					valueFn: (value) => `"${value}"`
				},
				fontSize: {
					name: $.Localize('#Customizer_FontSize'),
					type: CustomizerPropertyType.NUMBER_ENTRY,
					targetPanel: '.showpos-entry__label',
					styleProperty: 'fontSize',
					valueFn: (value) => `${value}px`
				},
				fontColor: {
					name: $.Localize('#Customizer_FontColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.showpos-entry__label',
					styleProperty: 'color',
					callbackFunc: (panel, value) =>
						(panel.style.textShadowFast = getTextShadowFast(value as rgbaColor, 0.9))
				},
				backgroundColor: {
					name: $.Localize('#Customizer_BackgroundColor'),
					type: CustomizerPropertyType.COLOR_PICKER,
					targetPanel: '.showpos-entry',
					styleProperty: 'backgroundColor'
				},
				alignText: {
					name: $.Localize('#Customizer_AlignText'),
					type: CustomizerPropertyType.DROPDOWN,
					options: [
						{ label: 'Left', value: 'left' },
						{ label: 'Center', value: 'center' },
						{ label: 'Right', value: 'right' }
					],
					targetPanel: ['.showpos-entry', '.showpos-entry__label'],
					styleProperty: 'horizontalAlign'
				}
			}
		});
	}
}
