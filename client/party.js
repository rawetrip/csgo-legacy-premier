'use strict';
// [自定义] 让客户端认为本地账号处于优先（Prime）状态 —— 2026-09-28
// 自建 GC 替换官方 GC 后，客户端拿不到 elevated 状态：我们从 SO 缓存下发的
// CSOEconGameAccountClient（type 7 / elevated_state=5）客户端收下了但没采纳，
// UI 便一路按"非优先"渲染 —— 主菜单的"获取优先"按钮、比赛设置里的"非优先帐户玩家"、
// 段位的"优先状态下，解冻你的段位"。这里直接在 API 层掰正，一次覆盖所有调用点：
//   MyPersonaAPI.GetElevatedState()       ← tooltip_lobby_settings / popup_prime_status / popup_accept_match
//   PartyListAPI  / FriendsListAPI 的 GetFriendPrimeEligible() ← mainmenu_play / sessionutil /
//                                         party / playercard / operation_*
( function ()
{
	$.Msg( '[csgc] installing prime bypass' );

	try
	{
		MyPersonaAPI.GetElevatedState = function () { return 'elevated'; };
		$.Msg( '[csgc] GetElevatedState patched (direct assign)' );
	}
	catch ( err )
	{
		try
		{
			Object.defineProperty( MyPersonaAPI, 'GetElevatedState',
				{ value: function () { return 'elevated'; }, writable: true, configurable: true } );
			$.Msg( '[csgc] GetElevatedState patched (defineProperty)' );
		}
		catch ( err2 )
		{
			$.Msg( '[csgc] GetElevatedState patch FAILED: ' + err2 );
		}
	}

	// 注意：CS:GO 里有**两个**同名 API —— 只 patch PartyListAPI 不够。
	// 玩家卡片（playercard.js:568 的 _IsPlayerPrime）走的是 FriendsListAPI，
	// 所以上一版比赛设置面板变对了、玩家卡片却还是"优先状态下，解冻你的段位"。
	// 只对本地玩家返回 true，好友保持真实状态（避免好友列表全部挂上优先徽章）。
	var _localXuid = MyPersonaAPI.GetXuid();
	var _patchPrimeEligible = function ( apiName, api )
	{
		try
		{
			var orig = api.GetFriendPrimeEligible;
			api.GetFriendPrimeEligible = function ( xuid )
			{
				if ( String( xuid ) === String( _localXuid ) ) return true;
				return orig ? orig.call( api, xuid ) : false;
			};
			$.Msg( '[csgc] ' + apiName + '.GetFriendPrimeEligible patched' );
		}
		catch ( err )
		{
			$.Msg( '[csgc] ' + apiName + '.GetFriendPrimeEligible patch FAILED: ' + err );
		}
	};

	_patchPrimeEligible( 'PartyListAPI', PartyListAPI );
	_patchPrimeEligible( 'FriendsListAPI', FriendsListAPI );
} )();


                                               
	            
		     
		  
		          
		    
		           
			    
				      
				        
				     
				   
				      
				     
				       
				         
				    
				     
			    
			    
	           
	          
	        
  


                                                     
                                                       
                                                     
var PartyMenu = ( function()
{
	var m_eventRebuildPartyList;

	var m_prevMembersInParty = -1;

	var _Init = function()
	{
		_RefreshPartyMembers();
		_AddOnActivateLeaveBtn();
		_ShowMatchmakingStatusTooltipEvent();
	};

	var _RefreshPartyMembers = function()
	{
		if ( !_IsSessionActive() )
		{
			return;
		}

		var lobbySettings = LobbyAPI.GetSessionSettings().game;
		if ( !lobbySettings )
		{
			return;
		}


		var elPartyMembersList = $( '#PartyList' ).FindChildInLayoutFile( 'PartyMembers' );
		var numPlayersActuallyInParty = PartyListAPI.GetCount();

		if ( numPlayersActuallyInParty > m_prevMembersInParty )
		{
			$.DispatchEvent( 'PlaySoundEffect', 'PanoramaUI.Lobby.Joined', 'PartyList' );
		}
		else if ( numPlayersActuallyInParty < m_prevMembersInParty )
		{
			$.DispatchEvent( 'PlaySoundEffect', 'PanoramaUI.Lobby.Left', 'PartyList' );
		}

		m_prevMembersInParty = numPlayersActuallyInParty;


		                                                                                    
		var bIsSearching = _IsSearching();
		if ( numPlayersActuallyInParty >= PartyListAPI.GetPartySessionUiThreshold() || bIsSearching )
		{
			elPartyMembersList.RemoveAndDeleteChildren();
			_UpdateMembersList( lobbySettings, numPlayersActuallyInParty );
		}
		else
		{
			$( '#PartyList' ).AddClass( 'hidden' );
			elPartyMembersList.RemoveAndDeleteChildren();
			friendsList.HideLocalPlayer( false );
		}

		                                                               
		                                                                                                                               
		$( '#PartyList' ).GetParent().SetHasClass( 'friendslist-party-searching', bIsSearching && ( numPlayersActuallyInParty <= 1 ) );

		_UpdateLeaveBtn( numPlayersActuallyInParty );
	};

	var _IsSessionActive = function()
	{
		if ( !LobbyAPI.IsSessionActive() )
		{
			$( '#PartyList' ).AddClass( 'hidden' );
			$( '#PartyList' ).GetParent().SetHasClass( 'friendslist-party-searching', false );
			friendsList.HideLocalPlayer( false );
			return false;
		}

		return true;
	};

	var _UpdateMembersList = function( lobbySettings, numPlayersActuallyInParty )
	{
		                                                                  
		                                                                                          
		var maxAllowedInLobby = 10;
		var numPlayersPossibleInMode = SessionUtil.GetMaxLobbySlotsForGameMode( lobbySettings.mode );

		$( '#PartyList' ).RemoveClass( 'hidden' );

		friendsList.HideLocalPlayer( true );

		for ( var i = 0; i < maxAllowedInLobby; i++ )
		{
			var xuid = i < numPlayersActuallyInParty ? PartyListAPI.GetXuidByIndex( i ) : 0;
		
			var isOverPossible = ( numPlayersActuallyInParty > numPlayersPossibleInMode ) ? true : false;
			var elPartyMemberCurrent = null;

			if ( i < numPlayersActuallyInParty )
			{
				elPartyMemberCurrent = _MakeNewPartyMemberTile( "PartyMember" + i, xuid );
				_SetPartyMemberName( elPartyMemberCurrent, xuid );
				_SetPartyMemberRank( elPartyMemberCurrent, xuid );
				_SetPrimeForMember( elPartyMemberCurrent, xuid );
				_UpdateAvatar( elPartyMemberCurrent, xuid )
				_TintForOverPlayerCountForMode( elPartyMemberCurrent, isOverPossible );
			}
		}

		_SetLobbyTitle( numPlayersPossibleInMode, numPlayersActuallyInParty );
	};

	var _MakeNewPartyMemberTile = function( panelIdToLoad, xuid )
	{
		var elParent = $.GetContextPanel().FindChildInLayoutFile( 'PartyMembers' );
		var elPartyMember = $.CreatePanel( "Panel", elParent, panelIdToLoad );
		elPartyMember.BLoadLayoutSnippet( 'PartyMember' );
		elPartyMember.Data().xuid = xuid; 
		var memberBtn = elPartyMember.FindChildInLayoutFile( 'PartyMemberBtn');

		var elAvatar =  $.CreatePanel( "Panel", memberBtn, xuid );
		_SetAttributeStringsOnAvatarPanel( elAvatar, xuid );
		elAvatar.BLoadLayout( 'file://{resources}/layout/avatar.xml', false, false );
		elAvatar.BLoadLayoutSnippet( "AvatarParty" );
		elAvatar.enabled = false;

		memberBtn.MoveChildBefore( elAvatar,memberBtn.GetChild( 0 ) );

		if ( xuid !== 0 && xuid )
			_AddOpenPlayerCardAction( memberBtn, xuid );
		else
			_ClearExisitingOnActivateEvent( memberBtn );

		return elPartyMember;
	};

	var _UpdateAvatar = function( elPartyMember, xuid )
	{
		var elAvatar = elPartyMember.FindChildInLayoutFile( xuid );
		Avatar.Init( elAvatar, xuid, 'playercard' );
	};

	var _SetPartyMemberName = function( elPartyMember, xuid )
	{
		var elName = elPartyMember.FindChildInLayoutFile( 'JsFriendName' );
		elName.text = FriendsListAPI.GetFriendName( xuid );
	};

	var _SetPartyMemberRank = function( elPartyMember, xuid )
	{
		var skillgroupType = PartyListAPI.GetFriendCompetitiveRankType( xuid );
		var skillGroup = PartyListAPI.GetFriendCompetitiveRank( xuid, skillgroupType );
		var wins = PartyListAPI.GetFriendCompetitiveWins( xuid, skillgroupType );
		var winsNeededForRank = SessionUtil.GetNumWinsNeededForRank( skillgroupType );
		var elRank = elPartyMember.FindChildInLayoutFile( 'PartyRank' ); 

		                                                                                                                                                    
		
		if ( wins < winsNeededForRank || ( wins >= winsNeededForRank && skillGroup < 1 ) || !PartyListAPI.GetFriendPrimeEligible( xuid ) )
		{
			elRank.visible = false;
			return;
		}

		var imageName = ( skillgroupType !== 'Competitive' ) ? skillgroupType : 'skillgroup';
		elRank.SetImage( 'file://{images}/icons/skillgroups/' + imageName + skillGroup + '.svg' );
		elRank.visible = true;
	};

	var _SetPrimeForMember = function( elPartyMember, xuid )
	{
		var elPrime = elPartyMember.FindChildInLayoutFile( 'PartyPrime' ); 
		elPrime.visible = PartyListAPI.GetFriendPrimeEligible( xuid );
	};

	var _TintForOverPlayerCountForMode = function ( elPartyMember, isOverCount )
	{
		elPartyMember.SetHasClass( 'friendtile--warning', isOverCount );
	}

	var _SetLobbyTitle = function (  numPlayersPossibleInMode, numPlayersActuallyInParty )
	{
		var elPanel = $( '#PartyList' ).FindChildInLayoutFile( 'PartyListHeader' );
		var isSoloSearch = ( numPlayersActuallyInParty === 1 );

		elPanel.FindChildInLayoutFile( 'PartyCancelBtn' ).visible = LobbyAPI.BIsHost() && _IsSearching();

		var elCount = elPanel.FindChildInLayoutFile( 'PartyTitleAlertText' );
		elCount.text = numPlayersActuallyInParty +'/' +numPlayersPossibleInMode;

		                                                                         
		                                                          
	}

	var _SetAttributeStringsOnAvatarPanel = function( elAvatar, xuid )
	{
		elAvatar.SetAttributeString( 'xuid', xuid );
		elAvatar.SetAttributeString( 'showleader', _ShowLobbyLeaderIcon( xuid ) );
	};

	var _ShowLobbyLeaderIcon = function( xuid )
	{
		return LobbyAPI.GetHostSteamID() === xuid ? 'show' : '';
	};

	var _AddOpenPlayerCardAction = function( elPartyMember, xuid )
	{
		var openCard = function( xuid )
		{
			                                                                                             
			$.DispatchEvent( 'SidebarContextMenuActive', true );

			if ( xuid !== 0 )
			{
				var contextMenuPanel = UiToolkitAPI.ShowCustomLayoutContextMenuParametersDismissEvent(
					'',
					'',
					'file://{resources}/layout/context_menus/context_menu_playercard.xml',
					'xuid=' + xuid,
					function()
					{
						$.DispatchEvent( 'SidebarContextMenuActive', false );
					}
				);
				contextMenuPanel.AddClass( "ContextMenu_NoArrow" );
			}
		};

		elPartyMember.SetPanelEvent( "onactivate", openCard.bind( undefined, xuid ) );
		elPartyMember.SetPanelEvent( "oncontextmenu", openCard.bind( undefined, xuid ) );
	};

	var _ClearExisitingOnActivateEvent = function( elPartyMember )
	{
		elPartyMember.SetPanelEvent( "onactivate", function()
		{

		} );

		var OnMouseOver = function( elPartyMember )
		{
			UiToolkitAPI.ShowTextTooltip( elPartyMember.id, '#tooltip_invite_to_lobby' );
		};

		elPartyMember.SetPanelEvent( "onmouseover", OnMouseOver.bind( undefined, elPartyMember ) );

		elPartyMember.SetPanelEvent( "onmouseout", function()
		{
			UiToolkitAPI.HideTextTooltip();
		} );
	};

	var _SessionUpdate = function( updateType )
	{
		                                                                                                      
		if ( LobbyAPI.IsSessionActive() )
		{
			if ( m_eventRebuildPartyList == undefined )
			{
				m_eventRebuildPartyList = $.RegisterForUnhandledEvent( "PanoramaComponent_PartyList_RebuildPartyList", PartyMenu.RefreshPartyMembers );
			}
		}
		else
		{
			if ( m_eventRebuildPartyList )
			{
				$.UnregisterForUnhandledEvent( "PanoramaComponent_PartyList_RebuildPartyList", m_eventRebuildPartyList );
				m_eventRebuildPartyList = undefined;
			}
		}

		_RefreshPartyMembers();
		_TintBgForSearch();
	};

	var _TintBgForSearch = function()
	{	
		var serverWarning = NewsAPI.GetCurrentActiveAlertForUser();
		var isWarning = serverWarning !== '' && serverWarning !== undefined ? true : false;

		$.GetContextPanel().FindChildInLayoutFile( 'MatchStatusBackground' ).SetHasClass( 'party-list__bg--warning', ( isWarning && _IsSeaching() ) );
		$.GetContextPanel().FindChildInLayoutFile( 'MatchStatusBackground' ).SetHasClass( 'party-list__bg--searching', _IsSeaching() );
	};

	var _IsSeaching = function()
	{
		var StatusString = _GetSearchStatus();
		return ( StatusString !== '' && StatusString !== null ) ? true : false;
	};

	var _PlayerActivityVoice = function( xuid )
	{
		var elPartyMembersList = $( '#PartyList' ).FindChildInLayoutFile( 'PartyMembers' );

		elPartyMembersList.Children().forEach(element => {
			if ( element.Data().xuid === xuid )
			{
				var elAvatar = element.FindChildInLayoutFile( xuid );
				if ( elAvatar )
				{
					Avatar.UpdateTalkingState( elAvatar, xuid );
				}
			}
		});
	};

	                                                                                                    
	var _UpdateLeaveBtn = function ( numPlayersActuallyInParty )
	{
		var elLeaveBtn = $( '#PartyList' ).FindChildInLayoutFile( 'PartyLeaveBtn' );
		elLeaveBtn.visible = ( !GameStateAPI.IsLocalPlayerPlayingMatch() && LobbyAPI.IsSessionActive() );
	};

	var _AddOnActivateLeaveBtn= function ()
	{
		var elLeaveBtn = $( '#PartyList' ).FindChildInLayoutFile( 'PartyLeaveBtn' );
		elLeaveBtn.SetPanelEvent( 'onactivate', function(){ LobbyAPI.CloseSession(); } );
	};
	
	                                                                                                    
	                          
	                                                                                                    
	var _GetSearchStatus = function()
	{
		return LobbyAPI.GetMatchmakingStatusString();
	};

	var _IsSearching = function()
	{
		var StatusString = _GetSearchStatus();
		return ( StatusString !== '' && StatusString !== null ) ? true : false;
	};

	                                                                                                    

	var _ShowMatchmakingStatusTooltipEvent = function()
	{
		var btnSettings = $.GetContextPanel().FindChildInLayoutFile( 'MatchStatusInfo' );
		btnSettings.SetPanelEvent( 'onmouseover', function()
		{
			UiToolkitAPI.ShowCustomLayoutParametersTooltip( 'MatchStatusInfo',
				'LobbySettingsTooltip',
				'file://{resources}/layout/tooltips/tooltip_lobby_settings.xml',
				'xuid=' + ''
			);
		} );

		btnSettings.SetPanelEvent( 'onmouseout', function() { UiToolkitAPI.HideCustomLayoutTooltip('LobbySettingsTooltip'); } );
	};

	var _ShowMatchAcceptPopUp = function( map )
	{
		var popup = UiToolkitAPI.ShowGlobalCustomLayoutPopupParameters( '', 'file://{resources}/layout/popups/popup_accept_match.xml', 'map_and_isreconnect=' + map + ',false' );
		$.DispatchEvent( "ShowAcceptPopup", popup );
	};

	return {
		Init	: _Init,
		SessionUpdate	: _SessionUpdate,
		RefreshPartyMembers	:_RefreshPartyMembers,
		PlayerActivityVoice: _PlayerActivityVoice,
		ShowMatchAcceptPopUp: _ShowMatchAcceptPopUp
	};
} )();




                                                                                                    
                                           
                                                                                                    
(function()
{
	PartyMenu.Init();

	$.Msg( "[csgc] party.js LOADED v7" );
	var _csgcLast = null;
	var _csgcShown = false;
	var _csgcClosed = false;

	// close via the popup's own handler -- that is the official teardown path
	var _closePopup = function()
	{
		try { $.DispatchEvent( "PanoramaComponent_Lobby_ReadyUpForMatch", false, 0, 0 ); } catch ( e ) { }
		// NB: do NOT play popup_accept_match_confirmed here. In the '@' path the
		// official _OnNqmmAutoReadyUp already plays it -- playing it here as well is
		// exactly the 'lets roll twice' bug (which real CS2/CS:GO also have).
	};

	var _csgcWatch = function()
	{
		var status = "", mmq = "";
		try { status = String( LobbyAPI.GetMatchmakingStatusString() ); } catch ( e ) { status = ""; }
		try
		{
			var s = LobbyAPI.GetSessionSettings();
			if ( s && s.game ) mmq = String( s.game.mmqueue );
		}
		catch ( e ) { mmq = ""; }

		var conn = false;
		try { conn = !!GameStateAPI.IsPlayerConnected(); } catch ( e ) { conn = false; }

		// State-driven close (no timer guessing): fires the moment the client
		// actually connects, i.e. as the loading screen comes up -- the same
		// moment the official popup disappears. Only after WE raised it.
		try
		{
			if ( _csgcShown && ( GameStateAPI.IsLocalPlayerPlayingMatch() || conn ) )
			{
				if ( !_csgcClosed )
				{
					_csgcClosed = true;
					$.Msg( "[csgc] connected (conn=" + conn + ") -- closing popup" );
					_closePopup();
				}
			}
			else
			{
				_csgcClosed = false;
			}
		}
		catch ( e ) { }

		var sig = status + "|" + mmq;
		if ( sig !== _csgcLast )
		{
			$.Msg( "[csgc] state: mmstatus='" + status + "' mmqueue='" + mmq + "'" );
			_csgcLast = sig;
			var reserved = ( status.indexOf( "reserved" ) >= 0 ) || ( mmq === "reserved" );
			if ( reserved && !_csgcShown )
			{
				_csgcShown = true;
				$.Msg( "[csgc] RESERVED -- raising ServerReserved" );
				// the official trigger: party.js registered this event itself
				// use the real map the client is reserved for, not a hardcoded one
				var _map = "de_dust2";
				try { var _g = LobbyAPI.GetSessionSettings(); if ( _g && _g.game && _g.game.map ) _map = String( _g.game.map ); } catch ( e ) { }
				// '@' prefix = the official 'announcement only / auto ready-up' mode: the popup
				// takes its casual look, suppresses the beep, and 1.9s later calls
				// _OnNqmmAutoReadyUp -- which plays the confirmed sound, does
				// LobbyAPI.SetLocalPlayerReady('deferred') and closes via the official path.
				try { $.DispatchEvent( "ServerReserved", "@" + _map ); $.Msg( "[csgc] ServerReserved raised for @" + _map ); }
				catch ( e ) { $.Msg( "[csgc] raise threw: " + e ); }
				// the engine normally plays this when it raises ServerReserved itself;
				// since WE raise it, nobody else will -- play the match-ready sound here.
				try { $.DispatchEvent( "PlaySoundEffect", "popup_accept_match_found", "MOUSE" ); } catch ( e ) { }
				// Safety net only now: in the '@' path the popup closes itself at 1.9s via
				// the official _OnNqmmAutoReadyUp. Keep this well past csgc's connect.
				$.Schedule( 12.0, function()
				{
					$.Msg( "[csgc] timed close" );
					_closePopup();
				} );
			}
			else if ( !reserved )
			{
				_csgcShown = false;
			}
		}
		// poll fast: the popup's t=0 is our first poll after mmqueue flips to
		// 'reserved', and the close timer below is measured from there.
		$.Schedule( 0.2, _csgcWatch );
	};
	// THE close that matters: fires the instant a level starts loading, i.e.
	// exactly when the loading screen appears. Polling GameStateAPI never sees
	// this moment (IsPlayerConnected stays false while '正在连接至服务器...').
	$.RegisterForUnhandledEvent( 'GameState_LevelInitPreEntity', function()
	{
		if ( _csgcShown )
		{
			_csgcClosed = true;
			$.Msg( "[csgc] level init -- closing popup" );
			_closePopup();
		}
	} );

	$.Schedule( 1.0, _csgcWatch );
	$.RegisterForUnhandledEvent( "PanoramaComponent_Lobby_MatchmakingSessionUpdate", PartyMenu.SessionUpdate );
	$.RegisterForUnhandledEvent( "PanoramaComponent_Lobby_PlayerUpdated", PartyMenu.SessionUpdate );
	$.RegisterForUnhandledEvent( "PanoramaComponent_PartyList_PlayerActivityVoice", PartyMenu.PlayerActivityVoice );
	$.RegisterForUnhandledEvent( "ServerReserved", PartyMenu.ShowMatchAcceptPopUp );

})();
