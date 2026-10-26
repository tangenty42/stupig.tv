#!/bin/sh
set -eu

exec /opt/emqx/bin/emqx eval '
begin
  Check = fun(Stage, Operation) ->
    try Operation()
    catch _:_ -> error({mqtt_healthcheck_failed, Stage})
    end
  end,
  {Username, Password} = Check(bootstrap, fun() ->
    {ok, Bootstrap} = file:read_file(os:getenv("EMQX_AUTHENTICATION__1__BOOTSTRAP_FILE")),
    [#{<<"user_id">> := User, <<"password">> := Secret}] = emqx_utils_json:decode(Bootstrap),
    {User, Secret}
  end),
  Check(listeners, fun() ->
    true = emqx:get_config([listeners,tcp,default,enable_authn]),
    false = emqx:get_config([listeners,ws,default,enable_authn])
  end),
  Check(authorization, fun() ->
    deny = emqx:get_config([authorization,no_match]),
    disconnect = emqx:get_config([authorization,deny_action]),
    [#{type := file, enable := true, path := AclPath}] = emqx:get_config([authorization,sources]),
    {ok, _} = file:read_file(AclPath)
  end),
  Client = Check(client, fun() ->
    {ok, Pid} = emqtt:start_link([
      {host,{127,0,0,1}}, {port,1883}, {username,Username}, {password,Password}, {connect_timeout,3}
    ]),
    Pid
  end),
  unlink(Client),
  try
    Check(authentication, fun() -> {ok, _} = emqtt:connect(Client) end)
  after
    catch emqtt:stop(Client)
  end
end
'
