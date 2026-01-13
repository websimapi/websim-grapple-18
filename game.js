import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { TrackManager } from './track.js';
import { Car } from './car.js';
import { Explosion, SpaceEnvironment } from './effects.js';
import { ActionRecorder, ReplaySystem } from './replay.js';
import { InputManager } from './input_manager.js';
import { AudioManager } from './audio_manager.js';
import { CameraManager } from './camera_manager.js';

export class Game {
    constructor() {
        this.container = document.getElementById('game-container');
        this.scoreEl = document.getElementById('score-display');
        this.grappleScoreEl = document.getElementById('grapple-display');
        this.gameOverScreen = document.getElementById('game-over-screen');
        this.finalScoreEl = document.getElementById('final-score');
        this.uiLayer = document.getElementById('ui-layer');

        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x050505, 0.002);

        // removed camera setup logic
        this.cameraManager = new CameraManager();
        this.camera = this.cameraManager.camera;

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ 
            antialias: false,
            preserveDrawingBuffer: true 
        }); 
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.container.appendChild(this.renderer.domElement);

        // Post Processing (Bloom)
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));

        const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
        bloomPass.threshold = 0.1;
        bloomPass.strength = 1.2; 
        bloomPass.radius = 0.5;
        this.composer.addPass(bloomPass);

        // Lights
        this.addLights();

        // Input
        // removed input event listeners
        this.inputManager = new InputManager(this.renderer.domElement);

        // Resize
        window.addEventListener('resize', () => this.onWindowResize());

        // Game State
        this.loopStarted = false;
        this.isRunning = false;
        this.isCrashing = false;
        this.distanceTraveled = 0;
        this.explosions = [];

        // Bindings
        document.getElementById('restart-btn').addEventListener('click', () => this.respawn());

        // Audio
        // removed setupAudio() and local sound variables
        this.audioManager = new AudioManager(this.camera);

        // Multiplayer / User Info
        this.room = new WebsimSocket();
        this.remoteCars = {}; // Map clientId -> Car instance
        this.localState = 'LOBBY'; // LOBBY, PLAYING, DEAD, SPECTATING
        this.respawnTimer = 0;
        this.myMaxScore = 0; // Current round max score

        // Replay System
        // Updated to use deterministic JSON recording
        this.recorder = new ActionRecorder();
        this.replaySystem = null; // Initialized in start() or constructor if dependencies ready

        // Explosion / crash state
        this.explosionTriggered = false;
        this.explosionTime = 0;
        this.interceptorSpawned = false;

        // Render / replay UI refs
        this.renderOverlay = document.getElementById('render-start-screen');
        this.renderPlayBtn = document.getElementById('play-render-btn');
        this.replayLoaded = false;

        // Listen for external render commands
        window.addEventListener('message', (event) => {
            if (event.data && event.data.render) {
                this.loadReplayFromURL(event.data.render);
            }
        });

        // Detect render-mode from URL
        this.isRenderMode = !!new URLSearchParams(window.location.search).get('render');
        if (this.isRenderMode) {
            const toggleHandler = (e) => {
                // Only toggle when a replay is active
                if (this.isReplaying && this.replaySystem) {
                    if (this.replaySystem.isPlaying) {
                        // Pause and show overlay play button
                        this.replaySystem.isPlaying = false;
                        if (this.renderOverlay) {
                            this.renderOverlay.classList.remove('hidden');
                            this.renderOverlay.style.display = 'flex';
                        }
                    } else {
                        // Resume from current frame and hide overlay
                        this.replaySystem.isPlaying = true;
                        if (this.renderOverlay) {
                            this.renderOverlay.classList.add('hidden');
                        }
                    }
                }
            };
            this.renderer.domElement.addEventListener('click', toggleHandler);
            this.renderer.domElement.addEventListener('touchend', (e) => {
                e.preventDefault();
                toggleHandler(e);
            }, { passive: false });
        }
    }

    // removed setupAudio() {}

    addLights() {
        const ambientLight = new THREE.AmbientLight(0xffffff, 2.5);
        this.scene.add(ambientLight);

        const hemiLight = new THREE.HemisphereLight(0x88aaff, 0x222244, 1.2);
        this.scene.add(hemiLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
        dirLight.position.set(20, 40, 10);
        dirLight.castShadow = false;
        this.scene.add(dirLight);
    }

    async start() {
        this.audioManager.resumeContext();
        await this.room.initialize();
        
        // Multiplayer Listeners
        this.room.subscribeRoomState((state) => this.onRoomStateChange(state));
        this.room.subscribePresence((presence) => this.onPresenceChange(presence));
        
        if (this.uiLayer) this.uiLayer.style.display = 'block';
        
        // Initial Scene Setup (Empty track)
        this.initScene(this.room.roomState.seed || 12345);

        // Start Loop
        if (!this.loopStarted) this.loop();
        
        // Check for round status and handle stale states
        const state = this.room.roomState;
        
        // Apply initial UI state
        this.onRoomStateChange(state);

        if (!state.roundStatus || (state.roundStatus === 'ENDING' && Date.now() > (state.nextRoundTime || 0))) {
            // First time init OR Stale room (everyone left during ending)
            this.startNewRound();
        }
    }

    startNewRound() {
        if (this._startingRound) return;
        this._startingRound = true;
        this.room.updateRoomState({
            roundStatus: 'ACTIVE',
            seed: Math.floor(Math.random() * 100000),
            startTime: Date.now()
        });
        setTimeout(() => this._startingRound = false, 2000);
    }

    onRoomStateChange(state) {
        if (state.seed && (!this.trackManager || this.currentSeed !== state.seed)) {
            this.initScene(state.seed);
        }
        
        const spawnBtn = document.getElementById('spawn-btn');

        if (state.roundStatus === 'ENDING') {
            this.showRoundEndUI(state.nextRoundTime);
            if (spawnBtn) {
                spawnBtn.disabled = true;
                spawnBtn.innerText = "WAIT FOR NEXT ROUND";
                spawnBtn.classList.add('disabled');
            }
        } else if (state.roundStatus === 'ACTIVE') {
            this.hideRoundEndUI();
            if (spawnBtn) {
                spawnBtn.disabled = false;
                if (spawnBtn.innerText === "WAIT FOR NEXT ROUND") {
                    spawnBtn.innerText = "SPAWN IN";
                }
                spawnBtn.classList.remove('disabled');
            }
        }
    }

    onPresenceChange(presence) {
        // Sync visuals for other players
        Object.keys(presence).forEach(clientId => {
            if (clientId === this.room.clientId) return;
            
            const data = presence[clientId];
            if (!data) return; // Disconnected?

            let remoteCar = this.remoteCars[clientId];
            
            if (!data.alive) {
                if (remoteCar) {
                    remoteCar.hide();
                }
                return;
            }

            if (!remoteCar) {
                remoteCar = new Car(this.scene);
                // Make remote cars slightly distinct visually? (TODO)
                this.remoteCars[clientId] = remoteCar;
            }
            
            remoteCar.mesh.visible = true;
            remoteCar.updateRemote(data);
        });
        
        // Cleanup disconnected
        Object.keys(this.remoteCars).forEach(cid => {
            if (!presence[cid]) {
                this.scene.remove(this.remoteCars[cid].mesh);
                this.scene.remove(this.remoteCars[cid].hookMesh);
                this.scene.remove(this.remoteCars[cid].grappleRope);
                delete this.remoteCars[cid];
            }
        });
        
        this.updateLeaderboard();
        this.checkRoundEndCondition();
    }

    checkRoundEndCondition() {
        // Only Host checks
        const peers = Object.keys(this.room.peers).sort();
        if (peers[0] !== this.room.clientId) return;
        
        if (this.room.roomState.roundStatus !== 'ACTIVE') return;

        // Check if all players present are dead
        const allDead = peers.every(id => {
            const p = this.room.presence[id];
            return !p || !p.alive;
        });

        if (allDead && peers.length > 0) {
            // End Round
            const nextTime = Date.now() + 15000;
            this.room.updateRoomState({
                roundStatus: 'ENDING',
                nextRoundTime: nextTime
            });
            
            setTimeout(() => {
                this.startNewRound();
            }, 15000);
        }
    }

    spawnPlayer() {
        // Triggered by UI button
        if (this.room.roomState.roundStatus !== 'ACTIVE') return;
        
        // Wait 3 seconds
        const spawnBtn = document.getElementById('spawn-btn');
        if(spawnBtn) spawnBtn.innerText = "SPAWNING IN 3...";
        
        setTimeout(() => {
             if(spawnBtn) spawnBtn.innerText = "SPAWNING IN 2...";
        }, 1000);
        setTimeout(() => {
             if(spawnBtn) spawnBtn.innerText = "SPAWNING IN 1...";
        }, 2000);
        
        setTimeout(() => {
            this.localState = 'PLAYING';
            this.resetCarState();
            
            // Spawn logic: Behind peers?
            // Simple: Spawn at Z=0 but staggered X or Z based on ID index
            const peers = Object.keys(this.room.peers).sort();
            const myIndex = peers.indexOf(this.room.clientId);
            
            this.car.position.set(myIndex * 2.5 - 5, 2, -myIndex * 5); 
            this.car.direction.set(0, 0, 1);
            this.car.mesh.quaternion.identity();
            
            // UI
            document.getElementById('start-screen').classList.add('hidden');
            this.gameOverScreen.classList.add('hidden');
            
            // Audio
            this.audioManager.playEngine();
            
            // Recording
            this.recorder.start(this.trackManager);
            
        }, 3000);
    }

    initScene(seed) {
        this.currentSeed = seed;
        
        // Clear scene
        while(this.scene.children.length > 0){ 
            this.scene.remove(this.scene.children[0]); 
        }

        // Reset fog
        if (this.scene.fog) this.scene.fog.density = 0.002;
        
        this.explosions = [];
        this.remoteCars = {};

        // Re-add lights
        this.addLights();

        this.spaceEnvironment = new SpaceEnvironment(this.scene);
        this.trackManager = new TrackManager(this.scene, seed);
        this.car = new Car(this.scene);
        this.replaySystem = new ReplaySystem(this.car, this.trackManager, this.cameraManager, this.scene, this.spaceEnvironment, this.audioManager);
        
        // Add callback for replay end
        this.replaySystem.onReplayEnd = () => {
            this.localState = 'SPECTATING';
            this.car.hide();
        };

        this.cameraManager.reset(new THREE.Vector3(0, 0, 0));
        this.clock = new THREE.Clock();
        this.distanceTraveled = 0;
        this.myMaxScore = 0;
    }

    resetCarState() {
        this.isRunning = true;
        this.isReplaying = false;
        this.isCrashing = false;
        this.explosionTriggered = false;
        this.distanceTraveled = 0;
        this.car.mesh.visible = true;
        this.car.grappleState = 'IDLE';
        this.car.updateGrappleVisuals();
        
        // Reset track generation locally? No, track is persistent.
        // But we need to make sure we render segments near us.
        // TrackManager handles this in update (we will add logic).
    }

    respawn() {
        if (this.room.roomState.roundStatus !== 'ACTIVE') return;
        
        const savedMax = this.myMaxScore;
        
        // Reset scene to ensure clean track state for new run
        this.initScene(this.currentSeed);
        
        this.myMaxScore = savedMax;
        
        // Restore remote players immediately
        this.onPresenceChange(this.room.presence);
        
        this.localState = 'PLAYING';
        this.resetCarState();

        // Spawn Logic: Behind peers to start fresh
        const peers = Object.keys(this.room.peers).sort();
        const myIndex = peers.indexOf(this.room.clientId);
        
        this.car.position.set(myIndex * 2.5 - 5, 2, -myIndex * 5); 
        this.car.direction.set(0, 0, 1);
        this.car.mesh.quaternion.identity();
        
        this.cameraManager.reset(this.car.position);

        this.gameOverScreen.classList.add('hidden');
        const startScreen = document.getElementById('start-screen');
        if (startScreen) startScreen.classList.add('hidden');
        if (this.uiLayer) this.uiLayer.style.display = 'block';

        this.audioManager.playEngine();
        this.recorder.start(this.trackManager);
        this.room.updatePresence({ alive: true });
    }

    gameOver() {
        this.isRunning = false;
        this.isCrashing = true;
        this.explosionTriggered = false;
        this.interceptorSpawned = false;
        
        this.fallVelocity = this.car.direction.clone().multiplyScalar(20);
        this.fallVelocity.y = -10;

        this.car.grappleState = 'IDLE';
        this.car.updateGrappleVisuals();

        this.audioManager.stopEngine();
        
        // Update presence one last time
        this.room.updatePresence({ alive: false });
    }

    updateCrash(dt) {
        if (!this.explosionTriggered) {
            // Gravity
            this.fallVelocity.y -= 80 * dt; 
            
            // Apply velocity
            this.car.position.add(this.fallVelocity.clone().multiplyScalar(dt));
            this.car.mesh.position.copy(this.car.position);
            
            // Tumble rotation
            this.car.mesh.rotation.x += 5 * dt;
            this.car.mesh.rotation.z += 3 * dt;

            // Spawn Interceptor if falling deep enough
            if (!this.interceptorSpawned && this.car.position.y < -5) {
                const asteroid = this.spaceEnvironment.spawnInterceptor(this.car.position, this.fallVelocity);
                this.activeInterceptor = asteroid;
                this.recorder.recordInterceptor(asteroid.mesh.position, asteroid.velocity);
                this.interceptorSpawned = true;
            }

            // Check Collision with Asteroids
            const hit = this.spaceEnvironment.checkCollisions(this.car.position);
            
            // Trigger explosion on hit OR failsafe depth
            if (hit || this.car.position.y < -200) {
                this.triggerExplosion();
            }
        }

        // Camera follow logic
        const timeSinceExplosion = this.explosionTriggered ? (this.clock.getElapsedTime() - this.explosionTime) : 0;
        
        this.cameraManager.updateCrashZoom(
            dt, 
            this.car.position, 
            this.explosionTriggered, 
            timeSinceExplosion, 
            this.trackManager,
            this.scene
        );
    }

    triggerExplosion() {
        this.explosionTriggered = true;
        this.explosionTime = this.clock.getElapsedTime();
        this.recorder.markExplosion();

        const explosion = new Explosion(this.scene, this.car.position.clone());
        this.explosions.push(explosion);
        this.car.hide();
        this.audioManager.playSkid(true);

        // Update Presence
        this.room.updatePresence({ alive: false });
        
        // Delay before instant replay
        setTimeout(() => {
             this.startInstantReplay();
        }, 1500);
    }

    startInstantReplay() {
        this.localState = 'REPLAYING_DEATH';
        this.gameOverScreen.classList.remove('hidden');
        this.finalScoreEl.innerText = `Distance: ${Math.floor(this.distanceTraveled)}m`;
        
        const replayData = this.recorder.stop(this.trackManager);
        this.postHighScore(replayData); // Keep uploading high score for leaderboards
        
        this.startBackgroundReplay(replayData);
        
        // Setup Respawn UI
        const restartBtn = document.getElementById('restart-btn');
        restartBtn.disabled = true;
        restartBtn.innerText = "WAIT 3s";
        restartBtn.classList.add('disabled');
        
        let wait = 3;
        const timer = setInterval(() => {
            wait--;
            if (wait <= 0) {
                clearInterval(timer);
                restartBtn.disabled = false;
                restartBtn.innerText = "SPAWN IN";
                restartBtn.classList.remove('disabled');
            } else {
                restartBtn.innerText = `WAIT ${wait}s`;
            }
        }, 1000);
    }

    async loadReplayFromURL(url) {
        try {
            this.audioManager.resumeContext();
            console.log("Loading replay from:", url);
            const response = await fetch(url);
            if (!response.ok) throw new Error("Network response was not ok");
            const data = await response.json();

            // Force reset to clear any current game state and setup scene
            this.localState = 'REPLAYING_DEATH';
            this.isRunning = false; // Stop game loop immediately, we only want replay
            
            // Hide UI elements
            const startScreen = document.getElementById('start-screen');
            if (startScreen) startScreen.classList.add('hidden');
            this.gameOverScreen.classList.add('hidden');
            if (this.uiLayer) this.uiLayer.style.display = 'none';

            this.startBackgroundReplay(data);
            this.replayLoaded = true;

            // Ensure loop is running if triggered from URL (bypassing start screen)
            if (!this.loopStarted) this.loop();

        } catch (e) {
            console.error("Failed to load replay:", e);
        }
    }

    startBackgroundReplay(data) {
        this.isCrashing = false;
        this.isRunning = false;
        this.isReplaying = true;
        
        // Reset effects
        while(this.explosions.length > 0) {
            const exp = this.explosions.pop();
            this.scene.remove(exp.mesh);
            this.scene.remove(exp.light);
        }
        this.car.mesh.visible = true; // Show car again
        
        this.replaySystem.load(data);
    }

    // Handle blue play button behavior in render= mode
    handleRenderPlayButton(url) {
        if (!this.replayLoaded) {
            // First time: load and start replay
            this.loadReplayFromURL(url);
        } else if (this.replaySystem) {
            // Already loaded: just resume from current frame
            this.replaySystem.isPlaying = true;
        }
    }

    async postHighScore(replayData) {
        try {
            let username = "Guest";
            let userid = "guest";
            
            if (this.room && this.room.clientId && this.room.peers) {
                const p = this.room.peers[this.room.clientId];
                if (p) {
                    username = p.username || "Guest";
                    userid = p.id || this.room.clientId;
                } else {
                    userid = this.room.clientId;
                }
            }

            // Upload replay JSON
            const jsonString = JSON.stringify(replayData);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const file = new File([blob], "replay.json", { type: "application/json" });
            
            const replayUrl = await websim.upload(file);

            const message = {
                userid: userid,
                username: username,
                score: [Math.floor(this.distanceTraveled), this.car.grappleCount],
                replay: replayUrl
            };

            if (window.parent) {
                window.parent.postMessage(message, '*');
                console.log("High Score Posted with Replay URL", message);
            }

        } catch (e) {
            console.error("Error posting high score:", e);
        }
    }

    onWindowResize() {
        this.cameraManager.resize(window.innerWidth, window.innerHeight);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.composer.setSize(window.innerWidth, window.innerHeight);
    }

    loop() {
        this.loopStarted = true;
        requestAnimationFrame(() => this.loop());

        const dt = Math.min(this.clock.getDelta(), 0.1); 

        // 1. Update Explosions
        for (let i = this.explosions.length - 1; i >= 0; i--) {
            const exp = this.explosions[i];
            exp.update(dt);
            if (!exp.alive) {
                this.explosions.splice(i, 1);
            }
        }
        
        // 2. Environment
        if (this.spaceEnvironment) {
            this.spaceEnvironment.update(dt, this.camera.position);
        }

        // Watchdog for stuck rounds
        if (this.room.roomState.roundStatus === 'ENDING' && this.room.roomState.nextRoundTime) {
            if (Date.now() > this.room.roomState.nextRoundTime + 2000) {
                 // Round end timer finished but no one started new round (Host left?)
                 this.startNewRound();
            }
        }

        // 3. State Machine
        if (this.localState === 'PLAYING') {
            if (this.isRunning) {
                // Update Logic
                this.car.update(dt, this.inputManager, this.trackManager);
                this.recorder.recordFrame(this.car, this.activeInterceptor, dt);

                // Track Gen
                const distToHead = this.car.position.distanceTo(this.trackManager.currentPos);
                if (distToHead < 200) { // Increased buffer for speed
                    this.trackManager.generateNextSegment();
                }

                // Collision
                if (!this.trackManager.isOnTrack(this.car.position)) {
                    this.gameOver();
                }

                // Score
                this.distanceTraveled += this.car.speed * dt;
                this.myMaxScore = Math.max(this.myMaxScore, this.distanceTraveled);
                this.scoreEl.innerText = `DISTANCE: ${Math.floor(this.distanceTraveled)}m`;
                this.grappleScoreEl.innerText = `GRAPPLES: ${this.car.grappleCount}`;

                // Camera
                this.cameraManager.updateFollow(this.car.position, dt);

                // SFX
                if(this.car.grappleState === 'FIRING') {
                    this.audioManager.playGrapple();
                }
                
                // Network Update
                this.room.updatePresence({
                    x: this.car.position.x, y: this.car.position.y, z: this.car.position.z,
                    qx: this.car.mesh.quaternion.x, qy: this.car.mesh.quaternion.y, qz: this.car.mesh.quaternion.z, qw: this.car.mesh.quaternion.w,
                    hookX: this.car.hookPosition.x, hookY: this.car.hookPosition.y, hookZ: this.car.hookPosition.z,
                    state: this.car.grappleState,
                    score: Math.floor(this.distanceTraveled),
                    maxScore: Math.floor(this.myMaxScore),
                    alive: true
                });

            } else if (this.isCrashing) {
                this.updateCrash(dt);
                this.recorder.recordFrame(this.car, this.activeInterceptor, dt);
                // Camera logic handled in updateCrash
            }
        } 
        else if (this.localState === 'REPLAYING_DEATH') {
            this.replaySystem.update(dt);
        }
        else if (this.localState === 'SPECTATING') {
            // Find leader
            let bestScore = -1;
            let leaderId = null;
            
            Object.keys(this.room.presence).forEach(id => {
                const p = this.room.presence[id];
                if (p.alive && p.score > bestScore) {
                    bestScore = p.score;
                    leaderId = id;
                }
            });
            
            // Only update spectate text if we have a leader
            const spectateEl = document.getElementById('replay-hint');
            
            if (leaderId && this.remoteCars[leaderId]) {
                const targetCar = this.remoteCars[leaderId];
                this.cameraManager.updateFollow(targetCar.position, dt);
                
                const peer = this.room.peers[leaderId];
                if(spectateEl) spectateEl.innerText = `SPECTATING ${peer ? peer.username : 'PLAYER'}`;
                
                // Ensure track is generated for what we are seeing
                const distToHead = targetCar.position.distanceTo(this.trackManager.currentPos);
                if (distToHead < 200) {
                    this.trackManager.generateNextSegment();
                }
            } else {
                // Free cam or circle? Just idle
                if(spectateEl) spectateEl.innerText = "WAITING FOR PLAYERS";
            }
        }
        else if (this.localState === 'LOBBY') {
             // Orbit camera or similar?
             const t = Date.now() * 0.0001;
             this.camera.position.set(Math.cos(t)*50, 20, Math.sin(t)*50);
             this.camera.lookAt(0,0,0);
        }

        this.composer.render();
    }
    
    updateLeaderboard() {
        const list = document.getElementById('leaderboard-list');
        if (!list) return;
        
        // Get all players (peers + me)
        const allData = [];
        Object.keys(this.room.peers).forEach(id => {
             const peer = this.room.peers[id];
             const presence = this.room.presence[id] || {};
             const isMe = id === this.room.clientId;
             
             allData.push({
                 id: id,
                 username: peer.username,
                 avatarUrl: peer.avatarUrl,
                 score: isMe ? Math.floor(this.myMaxScore) : (presence.maxScore || 0),
                 alive: isMe ? (this.localState === 'PLAYING' && this.isRunning) : (presence.alive !== false)
             });
        });
        
        // Sort by Score Desc
        allData.sort((a,b) => b.score - a.score);
        
        // Render
        list.innerHTML = '';
        allData.forEach(p => {
            const item = document.createElement('div');
            item.className = 'lb-item';
            item.innerHTML = `
                <img src="${p.avatarUrl}" class="lb-avatar" />
                <div class="lb-info">
                    <div class="lb-name">${p.username}</div>
                    <div class="lb-score">${p.score}m ${p.alive ? '' : '💀'}</div>
                </div>
            `;
            list.appendChild(item);
        });
    }

    showRoundEndUI(nextTime) {
        const ui = document.getElementById('round-end-ui');
        const timer = document.getElementById('round-timer');
        if (ui && timer) {
            ui.classList.remove('hidden');
            const update = () => {
                const left = Math.max(0, Math.ceil((nextTime - Date.now()) / 1000));
                timer.innerText = `NEXT ROUND IN ${left}s`;
                if (left > 0 && this.room.roomState.roundStatus === 'ENDING') {
                     requestAnimationFrame(update);
                } else {
                     ui.classList.add('hidden');
                }
            };
            update();
        }
    }
    
    hideRoundEndUI() {
        const ui = document.getElementById('round-end-ui');
        if(ui) ui.classList.add('hidden');
    }
}